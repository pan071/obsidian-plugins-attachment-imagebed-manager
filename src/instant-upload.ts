import { Editor, MarkdownFileInfo, MarkdownView, Notice, TAbstractFile, TFile } from "obsidian";
import { EditorState, Extension, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type AttachmentImagebedManagerPlugin from "./plugin";
import { Candidate, LocalRef, UploadResult } from "./types";
import { extractLocalRefs } from "./link-parser";
import { getReplacementForExt } from "./settings";
import { deleteS3Object } from "./s3-client";
import { replaceAllLiteral } from "./utils";

// region 常量

/** 粘贴/拖入后轮询编辑器寻找新链接的间隔（毫秒） */
const ARM_POLL_INTERVAL_MS = 300;
/** 粘贴/拖入后等待新链接出现的最长时间（毫秒），覆盖 Image Converter 转换耗时 */
const ARM_WINDOW_MS = 15000;
/** 判断附件是否为本次粘贴新建时允许的创建时间误差（毫秒） */
const CREATED_TOLERANCE_MS = 2000;
/** 外部写入的笔记需要保持无变化的时长（毫秒）后才处理 */
const EXTERNAL_QUIET_MS = 10000;
/** 本插件写回笔记后，在此时间内触发的修改事件视为自身写入（毫秒） */
const SELF_WRITE_WINDOW_MS = 5000;
/** 启动后延迟多久补处理关闭期间外部写入的附件（毫秒） */
const STARTUP_CATCHUP_DELAY_MS = 15000;

// endregion

// region 链接锁定（CodeMirror 扩展）

/** 编辑器中一段正在上传、禁止手动编辑的链接区间 */
interface UploadLock {
  /** 锁定标识，同一次上传的多处引用共用前缀 */
  id: string;
  /** 区间起点 */
  from: number;
  /** 区间终点 */
  to: number;
}

/** 新增锁定区间的状态效果 */
const addUploadLocks = StateEffect.define<UploadLock[]>();
/** 按标识前缀移除锁定区间的状态效果 */
const removeUploadLocks = StateEffect.define<string>();

/** 记录当前编辑器中全部锁定区间，并随文档改动同步映射位置 */
const uploadLockField = StateField.define<UploadLock[]>({
  create: () => [],
  update(locks, tr) {
    // 文档改动后映射区间位置：区间前插入时整体右移，区间后插入时保持不变
    let next = tr.docChanged
      ? locks.map((lock) => ({
          ...lock,
          from: tr.changes.mapPos(lock.from, 1),
          to: tr.changes.mapPos(lock.to, -1),
        }))
      : locks;
    for (const effect of tr.effects) {
      // 追加新的锁定区间
      if (effect.is(addUploadLocks)) next = [...next, ...effect.value];
      // 移除同一次上传的全部锁定区间
      if (effect.is(removeUploadLocks)) next = next.filter((lock) => !lock.id.startsWith(effect.value));
    }
    return next;
  },
});

/**
 * 链接后方显示的「上传中」小组件
 *
 * @author 启年
 * @createTime 2026-11-12 20:34
 */
class UploadingWidget extends WidgetType {
  /**
   * @param label 显示的文案
   */
  constructor(private readonly label: string) {
    super();
  }

  /**
   * 文案相同时复用 DOM，避免闪烁。
   *
   * @param other 另一个小组件
   * @returns 是否可以复用
   */
  eq(other: UploadingWidget): boolean {
    return other.label === this.label;
  }

  /**
   * 生成带旋转图标的「上传中」标签。
   *
   * @returns 小组件 DOM
   */
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "attachment-imagebed-manager-uploading-widget";
    // 旋转图标
    const spinner = document.createElement("span");
    spinner.className = "attachment-imagebed-manager-uploading-spinner";
    wrap.appendChild(spinner);
    wrap.appendChild(document.createTextNode(this.label));
    return wrap;
  }

  /**
   * 小组件不响应编辑器内的鼠标与键盘事件。
   *
   * @returns 始终忽略事件
   */
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 判断一次改动是否会修改到锁定区间（含区间内部插入）。
 *
 * @param fromA 改动起点
 * @param toA 改动终点
 * @param lock 锁定区间
 * @returns 是否触碰锁定区间
 */
function touchesLock(fromA: number, toA: number, lock: UploadLock): boolean {
  // 删除或替换与区间有重叠
  if (fromA < lock.to && toA > lock.from) return true;
  // 纯插入落在区间内部；插在区间首尾边界允许，便于粘贴后继续输入
  return fromA === toA && fromA > lock.from && fromA < lock.to;
}

/**
 * 构造链接锁定所需的编辑器扩展：锁定状态、上传中装饰、阻止手动编辑锁定区间。
 *
 * @param label 「上传中」文案
 * @returns CodeMirror 扩展
 */
export function buildUploadLockExtension(label: string): Extension {
  // 锁定区间加淡化样式，并在区间末尾显示「上传中」
  const decorations = EditorView.decorations.compute([uploadLockField], (state) => {
    const ranges: Range<Decoration>[] = [];
    for (const lock of state.field(uploadLockField)) {
      if (lock.from >= lock.to) continue;
      ranges.push(Decoration.mark({ class: "attachment-imagebed-manager-uploading-link" }).range(lock.from, lock.to));
      ranges.push(Decoration.widget({ widget: new UploadingWidget(label), side: 1 }).range(lock.to));
    }
    return Decoration.set(ranges, true);
  });

  // 只拦截用户的输入、删除、拖动；撤销与外部文件同步不拦截，避免编辑器与磁盘内容不一致
  const filter = EditorState.changeFilter.of((tr) => {
    if (!tr.docChanged) return true;
    if (!(tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))) return true;
    const locks = tr.startState.field(uploadLockField, false);
    if (!locks || locks.length === 0) return true;
    let blocked = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (locks.some((lock) => touchesLock(fromA, toA, lock))) blocked = true;
    });
    return !blocked;
  });

  return [uploadLockField, decorations, filter];
}

// endregion

/** 一次粘贴/拖入触发的监听会话 */
interface ArmSession {
  /** 发生粘贴/拖入的笔记 */
  noteFile: TFile;
  /** 发生粘贴/拖入的编辑器 */
  editor: Editor;
  /** 粘贴/拖入发生的时间 */
  startedAt: number;
  /** 粘贴/拖入前笔记里已经引用的附件路径，这些不属于本次新增 */
  baseline: Set<string>;
  /** 本次会话已处理过的附件路径 */
  handled: Set<string>;
}

/** 一次立即上传的结果 */
type InstantUploadOutcome = "replaced" | "link-removed" | "failed";

/**
 * 立即上传管理器：粘贴/拖入附件后立即上传并锁定链接，以及自动处理外部工具写入笔记的本地附件
 *
 * @author 启年
 * @createTime 2026-11-12 20:34
 */
export class InstantUploadManager {
  /** 正在立即上传的附件路径，外部写入流程与定时扫描遇到时跳过 */
  readonly inflightPaths = new Set<string>();
  /** 外部写入防抖计时器，按笔记路径区分 */
  private readonly externalTimers = new Map<string, number>();
  /** 正在处理外部写入的笔记路径，避免同一笔记并发处理 */
  private readonly externalRunning = new Set<string>();
  /** 本插件自己写回笔记的路径与时间，避免触发外部写入流程 */
  private readonly selfWrites = new Map<string, number>();
  /** 全部定时器，卸载时统一清理 */
  private readonly timers = new Set<number>();
  /** 状态栏「上传中」提示 */
  private statusBarEl: HTMLElement | null = null;
  /** 锁定标识自增序号 */
  private lockSeq = 0;

  /**
   * @param plugin 插件实例
   */
  constructor(private readonly plugin: AttachmentImagebedManagerPlugin) {}

  // region 注册与清理

  /**
   * 注册编辑器扩展、粘贴/拖入与文件修改事件、状态栏与启动补处理，仅桌面端调用。
   */
  register(): void {
    const { plugin } = this;
    // 链接锁定扩展
    plugin.registerEditorExtension(buildUploadLockExtension(plugin.t("uploadingWidget")));
    // 状态栏默认隐藏，有上传任务时显示数量
    this.statusBarEl = plugin.addStatusBarItem();
    this.statusBarEl.addClass("attachment-imagebed-manager-statusbar");
    this.refreshStatusBar();

    // 只记录粘贴/拖入发生，不阻止默认行为，兼容 Obsidian 默认处理与 Image Converter
    plugin.registerEvent(
      plugin.app.workspace.on("editor-paste", (_evt: ClipboardEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        this.arm(editor, info);
      })
    );
    plugin.registerEvent(
      plugin.app.workspace.on("editor-drop", (_evt: DragEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        this.arm(editor, info);
      })
    );
    // 外部工具写入笔记后防抖处理
    plugin.registerEvent(
      plugin.app.vault.on("modify", (file: TAbstractFile) => {
        this.onVaultModify(file);
      })
    );
    // 启动完成后补处理 Obsidian 关闭期间外部写入的附件
    plugin.app.workspace.onLayoutReady(() => {
      this.setTimer(() => {
        void this.runStartupCatchup();
      }, STARTUP_CATCHUP_DELAY_MS);
    });
  }

  /**
   * 卸载插件时清理全部定时器。
   */
  dispose(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.externalTimers.clear();
  }

  // endregion

  // region 粘贴/拖入即上传

  /**
   * 粘贴/拖入发生后开启一次监听会话，在编辑器中等待新增的本地附件链接出现。
   *
   * @param editor 发生粘贴/拖入的编辑器
   * @param info 编辑器所属视图或文件信息
   */
  private arm(editor: Editor, info: MarkdownView | MarkdownFileInfo): void {
    const { settings } = this.plugin;
    if (!settings.enabled || !settings.instantUploadEnabled) return;
    const noteFile = info.file;
    if (!(noteFile instanceof TFile) || noteFile.extension !== "md") return;
    // S3 未配置时不处理，保持本地附件
    if (!this.isS3Ready()) return;

    const session: ArmSession = {
      noteFile,
      editor,
      startedAt: Date.now(),
      baseline: this.collectReferencedPaths(editor.getValue(), noteFile),
      handled: new Set<string>(),
    };
    // 粘贴/拖入的附件由 Obsidian 或 Image Converter 异步写入，需要轮询等待链接出现
    const poll = () => {
      this.pollSession(session);
      if (Date.now() - session.startedAt < ARM_WINDOW_MS) this.setTimer(poll, ARM_POLL_INTERVAL_MS);
    };
    this.setTimer(poll, ARM_POLL_INTERVAL_MS);
  }

  /**
   * 扫描编辑器当前内容，找出本次粘贴/拖入新增的本地附件链接并开始上传。
   *
   * @param session 监听会话
   */
  private pollSession(session: ArmSession): void {
    const view = this.getEditorView(session.editor);
    // 编辑器已关闭或已切换到其他笔记时结束本次会话
    if (!view || !this.isEditorShowing(session.editor, session.noteFile)) return;
    const text = session.editor.getValue();
    for (const ref of extractLocalRefs(text)) {
      const file = this.plugin.resolveLinkedFile(ref.target, session.noteFile);
      if (!file || !this.isInstantUploadable(file)) continue;
      // 粘贴前已存在的引用、已处理或正在上传的附件都跳过
      if (session.baseline.has(file.path) || session.handled.has(file.path) || this.inflightPaths.has(file.path)) continue;
      session.handled.add(file.path);
      // 创建时间晚于粘贴/拖入的才是本次新建的文件，否则是拖入库中已有文件（复用、保留本地）
      const isNewFile = file.stat.ctime >= session.startedAt - CREATED_TOLERANCE_MS;
      void this.uploadInEditor(session.noteFile, session.editor, file, ref, isNewFile);
    }
  }

  /**
   * 锁定编辑器中的链接并上传附件，完成后只替换这条链接，再按删除策略处理本地文件。
   *
   * @param noteFile 链接所在笔记
   * @param editor 链接所在编辑器
   * @param file 待上传的附件
   * @param ref 链接信息
   * @param isNewFile 附件是否为本次粘贴/拖入新建
   * @returns 上传结果
   */
  private async uploadInEditor(
    noteFile: TFile,
    editor: Editor,
    file: TFile,
    ref: LocalRef,
    isNewFile: boolean
  ): Promise<InstantUploadOutcome> {
    const { plugin } = this;
    const lockId = `aim-${++this.lockSeq}`;
    const view = this.getEditorView(editor);
    // 锁定笔记中这条链接的全部出现位置，并显示上传中
    if (view) {
      const locks = this.findOccurrences(view.state.doc.toString(), ref.raw).map((from, index) => ({
        id: `${lockId}:${index}`,
        from,
        to: from + ref.raw.length,
      }));
      if (locks.length) view.dispatch({ effects: addUploadLocks.of(locks) });
    }
    this.inflightPaths.add(file.path);
    this.refreshStatusBar();

    let upload: UploadResult | null = null;
    try {
      upload = await plugin.uploadFile(file);
      const replacement = plugin.buildReplacement(ref, this.toCandidate(file, ref), upload.publicUrl);
      const replaced = await this.replaceInNote(noteFile, ref.raw, replacement, lockId);

      // 上传期间链接已被撤销或删除：不写回，删除本次新建的云端对象，本地文件保留
      if (replaced === 0) {
        if (upload.created) await deleteS3Object(plugin.settings.s3, upload.key).catch(() => {});
        plugin.addLog({ status: "instant-upload-link-removed", notePath: noteFile.path, sourcePath: file.path, remoteUrl: upload.publicUrl, trashed: false });
        await plugin.saveSettings();
        return "link-removed";
      }

      const record = { path: file.path, name: file.name, remoteUrl: upload.publicUrl };
      if (!isNewFile) {
        // 拖入的库内已有文件可能被其他笔记共用，只复用云端地址，不删除本地文件
        plugin.addLog({ status: "instant-upload-reused-kept-local", notePath: noteFile.path, sourcePath: file.path, remoteUrl: upload.publicUrl, trashed: false });
        await plugin.saveSettings();
      } else if (plugin.settings.deletePolicy === "immediate") {
        // 立即删除：本次新建的附件只被这条链接引用，直接移入回收站
        await plugin.deleteLocalFileRecords(noteFile, [record], "instant-upload-trashed");
      } else {
        // 延迟删除或「每次询问」：粘贴流程不弹窗，统一进入延迟删除队列，删除前会再检查引用
        plugin.scheduleDelayedDeletes(noteFile, [record]);
        await plugin.saveSettings();
      }
      return "replaced";
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Instant upload failed for ${file.path}:`, error);
      plugin.addLog({ status: "instant-upload-failed", notePath: noteFile.path, sourcePath: file.path, remoteUrl: upload?.publicUrl || "", trashed: false });
      await plugin.saveSettings();
      this.notifyFailure(noteFile, editor, file, ref, isNewFile, message);
      return "failed";
    } finally {
      // 无论成功失败都解除锁定
      this.removeLocks(editor, lockId);
      this.inflightPaths.delete(file.path);
      this.refreshStatusBar();
    }
  }

  /**
   * 上传失败时提示，并提供重试按钮。
   *
   * @param noteFile 链接所在笔记
   * @param editor 链接所在编辑器
   * @param file 上传失败的附件
   * @param ref 链接信息
   * @param isNewFile 附件是否为本次新建
   * @param message 失败原因
   */
  private notifyFailure(
    noteFile: TFile,
    editor: Editor,
    file: TFile,
    ref: LocalRef,
    isNewFile: boolean,
    message: string
  ): void {
    const { plugin } = this;
    const fragment = createFragment((el) => {
      el.createSpan({ text: plugin.t("instantUploadFailed", { name: file.name, error: message }) });
      const button = el.createEl("button", { text: plugin.t("retry"), cls: "attachment-imagebed-manager-retry" });
      // 重试时附件仍存在才重新上传
      button.addEventListener("click", () => {
        if (plugin.app.vault.getAbstractFileByPath(file.path) instanceof TFile) {
          void this.uploadInEditor(noteFile, editor, file, ref, isNewFile);
        }
      });
    });
    new Notice(fragment, 10000);
  }

  // endregion

  // region 外部写入自动上传

  /**
   * 笔记被修改时防抖，笔记连续 10 秒无变化后再处理其中的本地附件。
   *
   * @param file 被修改的文件
   */
  private onVaultModify(file: TAbstractFile): void {
    const { settings } = this.plugin;
    if (!settings.enabled || !settings.externalUploadEnabled) return;
    if (!(file instanceof TFile) || file.extension !== "md") return;
    // 本插件自己写回笔记触发的修改不再处理
    const selfWriteAt = this.selfWrites.get(file.path);
    if (selfWriteAt && Date.now() - selfWriteAt < SELF_WRITE_WINDOW_MS) return;
    // 重新计时，等待笔记停止变化
    const existing = this.externalTimers.get(file.path);
    if (existing) this.clearTimer(existing);
    const timer = this.setTimer(() => {
      this.externalTimers.delete(file.path);
      void this.processExternalNote(file);
    }, EXTERNAL_QUIET_MS);
    this.externalTimers.set(file.path, timer);
  }

  /**
   * 启动后补处理一次全库，覆盖 Obsidian 关闭期间外部工具写入的附件。
   */
  private async runStartupCatchup(): Promise<void> {
    const { settings } = this.plugin;
    if (!settings.enabled || !settings.externalUploadEnabled || !this.isS3Ready()) return;
    // 逐篇顺序处理，避免启动时并发请求过多
    for (const noteFile of this.plugin.app.vault.getMarkdownFiles()) {
      await this.processExternalNote(noteFile);
    }
  }

  /**
   * 处理外部写入笔记中的本地附件：上传后按链接原文替换，本地文件一律延迟删除。
   *
   * @param noteFile 待处理的笔记
   */
  private async processExternalNote(noteFile: TFile): Promise<void> {
    const { plugin } = this;
    if (!plugin.settings.enabled || !plugin.settings.externalUploadEnabled) return;
    if (this.externalRunning.has(noteFile.path) || !this.isS3Ready()) return;
    // 笔记仍在变化时稍后再处理
    if (Date.now() - noteFile.stat.mtime < EXTERNAL_QUIET_MS) {
      this.onVaultModify(noteFile);
      return;
    }

    this.externalRunning.add(noteFile.path);
    try {
      // 与定时扫描相同的筛选：附件文件夹内、定时扫描包含的类型、满足最小大小
      const candidates = await plugin.findCandidatesInNote(noteFile, {
        requireAutoCandidate: true,
        enforceAttachmentRoot: true,
        enforceSizeRule: true,
      });
      let changed = false;
      for (const candidate of candidates) {
        const file = candidate.file;
        // 正在立即上传、仍在写入或超过立即上传上限的附件跳过
        if (this.inflightPaths.has(file.path)) continue;
        if (Date.now() - file.stat.mtime < EXTERNAL_QUIET_MS) continue;
        if (this.exceedsInstantLimit(file)) continue;

        this.inflightPaths.add(file.path);
        this.refreshStatusBar();
        try {
          const upload = await plugin.uploadFile(file);
          let replaced = 0;
          for (const ref of candidate.refs) {
            replaced += await this.replaceInNote(noteFile, ref.raw, plugin.buildReplacement(ref, candidate, upload.publicUrl));
          }
          if (replaced === 0) {
            // 链接已不存在，删除本次新建的云端对象
            if (upload.created) await deleteS3Object(plugin.settings.s3, upload.key).catch(() => {});
            continue;
          }
          changed = true;
          // 外部写入的附件可能被工具再次引用，一律延迟删除，删除前会再检查引用
          plugin.scheduleDelayedDeletes(noteFile, [{ path: file.path, name: file.name, remoteUrl: upload.publicUrl }]);
          plugin.addLog({ status: "external-upload-replaced", notePath: noteFile.path, sourcePath: file.path, remoteUrl: upload.publicUrl, trashed: false });
        } catch (error: unknown) {
          console.error(`External upload failed for ${file.path}:`, error);
          plugin.addLog({ status: "external-upload-failed", notePath: noteFile.path, sourcePath: file.path, remoteUrl: "", trashed: false });
        } finally {
          this.inflightPaths.delete(file.path);
          this.refreshStatusBar();
        }
      }
      if (changed || candidates.length) await plugin.saveSettings();
    } catch (error: unknown) {
      console.error(`External upload scan failed for ${noteFile.path}:`, error);
    } finally {
      this.externalRunning.delete(noteFile.path);
    }
  }

  // endregion

  // region 链接替换

  /**
   * 在笔记中把指定链接原文替换为远程链接：笔记已在编辑器中打开时通过编辑器替换，否则直接改文件。
   * 只替换这条链接本身，笔记其他内容在上传期间被修改也不影响。
   *
   * @param noteFile 链接所在笔记
   * @param raw 链接原文
   * @param replacement 替换后的远程链接
   * @param lockId 立即上传的锁定标识，有值时优先替换锁定区间
   * @returns 实际替换的数量，0 表示链接已不存在
   */
  private async replaceInNote(noteFile: TFile, raw: string, replacement: string, lockId?: string): Promise<number> {
    const view = this.findOpenEditorView(noteFile);
    if (view) {
      const doc = view.state.doc.toString();
      // 优先使用仍然完整的锁定区间，其次按原文查找全部出现位置
      const locked = lockId
        ? view.state
            .field(uploadLockField, false)
            ?.filter((lock) => lock.id.startsWith(lockId) && doc.slice(lock.from, lock.to) === raw)
            .map((lock) => lock.from) || []
        : [];
      const positions = locked.length ? locked : this.findOccurrences(doc, raw);
      if (positions.length === 0) return 0;
      // 一次事务完成全部替换并解除锁定，撤销时作为独立一步
      view.dispatch({
        changes: positions.map((from) => ({ from, to: from + raw.length, insert: replacement })),
        effects: lockId ? removeUploadLocks.of(lockId) : [],
      });
      this.selfWrites.set(noteFile.path, Date.now());
      return positions.length;
    }

    // 笔记未打开：直接按链接原文替换文件内容，不再要求全文未变
    let count = 0;
    await this.plugin.app.vault.process(noteFile, (current) => {
      count = this.findOccurrences(current, raw).length;
      return count ? replaceAllLiteral(current, raw, replacement) : current;
    });
    if (count) this.selfWrites.set(noteFile.path, Date.now());
    return count;
  }

  /**
   * 解除指定上传的锁定区间。
   *
   * @param editor 链接所在编辑器
   * @param lockId 锁定标识
   */
  private removeLocks(editor: Editor, lockId: string): void {
    const view = this.getEditorView(editor);
    if (!view) return;
    try {
      // 已替换时锁定已随替换移除，这里只处理失败或链接被删除的情况
      const locks = view.state.field(uploadLockField, false);
      if (locks?.some((lock) => lock.id.startsWith(lockId))) {
        view.dispatch({ effects: removeUploadLocks.of(lockId) });
      }
    } catch {
      // 编辑器已销毁时忽略
    }
  }

  // endregion

  // region 工具方法

  /**
   * 判断附件是否可以立即上传：已启用的类型、不是笔记、不超过立即上传大小上限。
   *
   * @param file 附件
   * @returns 是否可以立即上传
   */
  private isInstantUploadable(file: TFile): boolean {
    const ext = file.extension.toLowerCase();
    if (ext === "md") return false;
    if (!this.plugin.settings.enabledExtensions.includes(ext)) return false;
    return !this.exceedsInstantLimit(file);
  }

  /**
   * 判断附件是否超过立即上传大小上限。
   *
   * @param file 附件
   * @returns 超过上限返回 true，上限为 0 表示不限
   */
  private exceedsInstantLimit(file: TFile): boolean {
    const limitMiB = Number(this.plugin.settings.instantUploadMaxSizeMiB) || 0;
    return limitMiB > 0 && file.stat.size > limitMiB * 1024 * 1024;
  }

  /**
   * 判断 S3 配置是否完整。
   *
   * @returns 配置完整返回 true
   */
  private isS3Ready(): boolean {
    try {
      this.plugin.ensureS3Settings();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 收集笔记文本中已引用的本地附件路径。
   *
   * @param text 笔记文本
   * @param noteFile 笔记文件
   * @returns 附件路径集合
   */
  private collectReferencedPaths(text: string, noteFile: TFile): Set<string> {
    const paths = new Set<string>();
    for (const ref of extractLocalRefs(text)) {
      const file = this.plugin.resolveLinkedFile(ref.target, noteFile);
      if (file) paths.add(file.path);
    }
    return paths;
  }

  /**
   * 查找文本中某段原文的全部出现位置。
   *
   * @param text 文本
   * @param raw 原文
   * @returns 起始位置列表
   */
  private findOccurrences(text: string, raw: string): number[] {
    const positions: number[] = [];
    if (!raw) return positions;
    let index = text.indexOf(raw);
    while (index !== -1) {
      positions.push(index);
      index = text.indexOf(raw, index + raw.length);
    }
    return positions;
  }

  /**
   * 构造生成替换链接所需的候选信息。
   *
   * @param file 附件
   * @param ref 链接信息
   * @returns 候选信息
   */
  private toCandidate(file: TFile, ref: LocalRef): Candidate {
    const ext = file.extension.toLowerCase();
    return {
      file,
      ext,
      replacement: getReplacementForExt(ext, this.plugin.settings),
      refs: [ref],
      referenceCount: 1,
      sizeBytes: file.stat.size,
    };
  }

  /**
   * 获取 Obsidian 编辑器底层的 CodeMirror 视图。
   *
   * @param editor Obsidian 编辑器
   * @returns CodeMirror 视图，旧版编辑器返回 null
   */
  private getEditorView(editor: Editor): EditorView | null {
    // Obsidian 未在类型中公开 cm 属性，桌面端 CodeMirror 6 编辑器均有该属性
    const view = (editor as unknown as { cm?: EditorView }).cm;
    return view instanceof EditorView ? view : null;
  }

  /**
   * 判断编辑器当前是否仍在显示指定笔记。
   *
   * @param editor 编辑器
   * @param noteFile 笔记
   * @returns 仍在显示返回 true
   */
  private isEditorShowing(editor: Editor, noteFile: TFile): boolean {
    return this.plugin.app.workspace
      .getLeavesOfType("markdown")
      .some((leaf) => leaf.view instanceof MarkdownView && leaf.view.editor === editor && leaf.view.file?.path === noteFile.path);
  }

  /**
   * 查找正在显示指定笔记的编辑器视图。
   *
   * @param noteFile 笔记
   * @returns CodeMirror 视图，笔记未打开时返回 null
   */
  private findOpenEditorView(noteFile: TFile): EditorView | null {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === noteFile.path) {
        const cm = this.getEditorView(view.editor);
        if (cm) return cm;
      }
    }
    return null;
  }

  /**
   * 刷新状态栏：有上传任务时显示数量，否则隐藏。
   */
  private refreshStatusBar(): void {
    if (!this.statusBarEl) return;
    const count = this.inflightPaths.size;
    this.statusBarEl.setText(count ? `☁ ${this.plugin.t("statusUploading", { count })}` : "");
    this.statusBarEl.toggleClass("attachment-imagebed-manager-statusbar-hidden", count === 0);
  }

  /**
   * 创建一次性定时器并登记，便于卸载时统一清理。
   *
   * @param callback 回调
   * @param ms 延迟毫秒数
   * @returns 定时器标识
   */
  private setTimer(callback: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, ms);
    this.timers.add(id);
    return id;
  }

  /**
   * 取消已登记的定时器。
   *
   * @param id 定时器标识
   */
  private clearTimer(id: number): void {
    window.clearTimeout(id);
    this.timers.delete(id);
  }

  // endregion
}
