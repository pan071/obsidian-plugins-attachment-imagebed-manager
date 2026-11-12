import { PluginSettings, S3Config, ReplacementType, PendingDelete, LogEntry, DeletePolicy } from "./types";
import { FILE_CATEGORIES } from "./file-categories";

const DEFAULT_S3: S3Config = {
  provider: "r2",
  endpoint: "",
  region: "auto",
  bucketName: "",
  accessKeyId: "",
  secretAccessKey: "",
  customDomainName: "",
  pathTemplate: "attachments/{ext}/{hash2}/{hash}.{ext}",
};

const DEFAULT_ENABLED_EXTS: string[] = [
  "pdf",
  "mp3", "m4a", "wav",
  "mp4", "mov",
  "epub",
];

const DEFAULT_MIN_SIZE: Record<string, number> = {
  pdf: 1,
  mp3: 10, m4a: 10, wav: 10,
  mp4: 0, mov: 0,
  epub: 10,
};

const DEFAULT_AUTO_CANDIDATE_EXTS: string[] = [
  "pdf",
  "mp3", "m4a", "wav",
  "mp4", "mov",
  "epub",
];

export const DEFAULT_SETTINGS: PluginSettings = {
  enabled: true,
  autoScanEnabled: false,
  scanIntervalMinutes: 30,
  quietSeconds: 600,
  autoScanMinSizeMiB: 0,
  attachmentRoot: "99 Attachments",
  deletePolicy: "confirm",
  autoDeleteDelayHours: 24,
  instantUploadEnabled: true,
  externalUploadEnabled: true,
  instantUploadMaxSizeMiB: 0,
  s3: DEFAULT_S3,
  enabledExtensions: DEFAULT_ENABLED_EXTS,
  minSizeRules: DEFAULT_MIN_SIZE,
  autoCandidateExts: DEFAULT_AUTO_CANDIDATE_EXTS,
  customExtensions: [],
  customReplacements: {},
  pendingDeletes: [],
  logs: [],
};

interface OldRule {
  extensions: string;
  minSizeMiB: number;
  autoCandidate: boolean;
  replacement: string;
}

interface OldLoadedSettings {
  r2?: Partial<S3Config>;
  rules?: OldRule[];
  s3?: Partial<S3Config>;
  provider?: string;
  region?: string;
  enabledExtensions?: string[];
  minSizeRules?: Record<string, number>;
  autoCandidateExts?: string[];
  customExtensions?: string[];
  customReplacements?: Record<string, ReplacementType>;
  pendingDeletes?: PendingDelete[];
  logs?: LogEntry[];
}

interface LoadedSettings {
  enabled?: unknown;
  autoScanEnabled?: unknown;
  scanIntervalMinutes?: unknown;
  quietSeconds?: unknown;
  autoScanMinSizeMiB?: unknown;
  attachmentRoot?: unknown;
  deletePolicy?: unknown;
  autoDeleteDelayHours?: unknown;
  instantUploadEnabled?: unknown;
  externalUploadEnabled?: unknown;
  instantUploadMaxSizeMiB?: unknown;
  r2?: Partial<S3Config>;
  s3?: Partial<S3Config>;
  provider?: string;
  region?: string;
  enabledExtensions?: string[];
  minSizeRules?: Record<string, number>;
  autoCandidateExts?: string[];
  customExtensions?: string[];
  customReplacements?: Record<string, ReplacementType>;
  pendingDeletes?: PendingDelete[];
  logs?: LogEntry[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取已保存的布尔设置，类型不符时回退默认值。
 *
 * @param value data.json 中保存的值
 * @param fallback 默认值
 * @returns 有效的布尔值
 */
function readBoolean(value: unknown, fallback: boolean): boolean {
  // 只接受真正的布尔值，避免字符串等脏数据被当成开启
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 读取已保存的非负数值设置，类型不符或不是有限数时回退默认值。
 *
 * @param value data.json 中保存的值
 * @param fallback 默认值
 * @returns 有效的非负数值
 */
function readNonNegativeNumber(value: unknown, fallback: number): number {
  // 允许 0（如延迟删除 0 小时），拒绝负数、NaN 与 Infinity
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 读取已保存的非空字符串设置，空白或类型不符时回退默认值。
 *
 * @param value data.json 中保存的值
 * @param fallback 默认值
 * @returns 有效的字符串
 */
function readNonEmptyString(value: unknown, fallback: string): string {
  // 去掉首尾空白后为空时视为未设置
  return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * 读取已保存的删除策略，取值不在枚举范围内时回退默认值。
 *
 * @param value data.json 中保存的值
 * @param fallback 默认删除策略
 * @returns 有效的删除策略
 */
function readDeletePolicy(value: unknown, fallback: DeletePolicy): DeletePolicy {
  // 仅接受插件支持的三种删除策略
  return value === "confirm" || value === "immediate" || value === "delayed" ? value : fallback;
}

function migrateOldSettings(loaded: OldLoadedSettings): Partial<PluginSettings> {
  const result: Partial<PluginSettings> = {};

  if (loaded.r2) {
    result.s3 = {
      ...DEFAULT_S3,
      ...loaded.r2,
      provider: "r2",
      region: "auto",
    };
  }

  if (Array.isArray(loaded.rules) && loaded.rules.length > 0) {
    const enabledExtensions: string[] = [];
    const minSizeRules: Record<string, number> = {};
    const autoCandidateExts: string[] = [];
    const customReplacements: Record<string, ReplacementType> = {};

    for (const rule of loaded.rules) {
      const exts = rule.extensions
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      for (const ext of exts) {
        enabledExtensions.push(ext);
        minSizeRules[ext] = rule.minSizeMiB;
        if (rule.autoCandidate) autoCandidateExts.push(ext);
        if (rule.replacement !== FILE_CATEGORIES.find((c) => c.extensions.includes(ext))?.replacement) {
          customReplacements[ext] = rule.replacement as ReplacementType;
        }
      }
    }

    result.enabledExtensions = enabledExtensions;
    result.minSizeRules = minSizeRules;
    result.autoCandidateExts = autoCandidateExts;
    result.customReplacements = customReplacements;
  }

  return result;
}

export function mergeSettings(defaults: PluginSettings, loaded: unknown): PluginSettings {
  const data: LoadedSettings = isObject(loaded) ? loaded as LoadedSettings : {};
  const migrated = migrateOldSettings(data);

  const s3Data = data.s3 || migrated.s3 || data.r2 || {};
  const s3: S3Config = {
    ...defaults.s3,
    ...s3Data,
    provider: s3Data.provider || (data.r2 ? "r2" : "r2"),
    region: s3Data.region || (s3Data.provider === "r2" || data.r2 ? "auto" : "us-east-1"),
  };

  return {
    ...defaults,
    // 恢复已保存的基础设置，修复每次启动都被重置为默认值的问题
    enabled: readBoolean(data.enabled, defaults.enabled),
    autoScanEnabled: readBoolean(data.autoScanEnabled, defaults.autoScanEnabled),
    scanIntervalMinutes: readNonNegativeNumber(data.scanIntervalMinutes, defaults.scanIntervalMinutes),
    quietSeconds: readNonNegativeNumber(data.quietSeconds, defaults.quietSeconds),
    autoScanMinSizeMiB: readNonNegativeNumber(data.autoScanMinSizeMiB, defaults.autoScanMinSizeMiB),
    attachmentRoot: readNonEmptyString(data.attachmentRoot, defaults.attachmentRoot),
    deletePolicy: readDeletePolicy(data.deletePolicy, defaults.deletePolicy),
    autoDeleteDelayHours: readNonNegativeNumber(data.autoDeleteDelayHours, defaults.autoDeleteDelayHours),
    // 立即上传相关设置，旧配置中没有时使用默认值（默认开启）
    instantUploadEnabled: readBoolean(data.instantUploadEnabled, defaults.instantUploadEnabled),
    externalUploadEnabled: readBoolean(data.externalUploadEnabled, defaults.externalUploadEnabled),
    instantUploadMaxSizeMiB: readNonNegativeNumber(data.instantUploadMaxSizeMiB, defaults.instantUploadMaxSizeMiB),
    s3,
    enabledExtensions: migrated.enabledExtensions || data.enabledExtensions || defaults.enabledExtensions,
    minSizeRules: migrated.minSizeRules || data.minSizeRules || defaults.minSizeRules,
    autoCandidateExts: migrated.autoCandidateExts || data.autoCandidateExts || defaults.autoCandidateExts,
    customExtensions: data.customExtensions || defaults.customExtensions,
    customReplacements: migrated.customReplacements || data.customReplacements || defaults.customReplacements,
    pendingDeletes: Array.isArray(data.pendingDeletes) ? data.pendingDeletes : [],
    logs: Array.isArray(data.logs) ? data.logs.slice(0, 100) : [],
  };
}

export function getReplacementForExt(
  ext: string,
  settings: PluginSettings
): ReplacementType {
  if (settings.customReplacements[ext]) return settings.customReplacements[ext];
  const allExts = [...FILE_CATEGORIES.flatMap((c) => c.extensions), ...settings.customExtensions];
  if (!allExts.includes(ext) && !settings.enabledExtensions.includes(ext)) return "markdown";
  const category = FILE_CATEGORIES.find((c) => c.extensions.includes(ext));
  return category?.replacement || "markdown";
}
