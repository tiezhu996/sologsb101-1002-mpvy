import type { Revisioned } from './persistence';

/** 辐照度缺失：采集设备未上报时以 null 保存（0 及负数同样视为无效，不参与归一化） */
export type IrradianceValue = number | null;

/** 组串采集读数 */
export interface Sample {
  id: string;
  /** 所属组串 */
  stringId: string;
  /** 采集时间 yyyy-MM-dd HH:mm */
  sampledAt: string;
  /** 电流（A） */
  currentA: number;
  /** 电压（V） */
  voltageV: number;
  /** 辐照度（W/m²）；缺失时为 null，由系统按同箱中位数 / 上一条有效值补全用于统计 */
  irradianceWm2: IrradianceValue;
  /** 离散率（%），由 utils/discrete.ts 计算后落库（剔除读数不计入，落 0） */
  discreteRate: number;
  /** 是否剔除统计：云影等异常读数保留原始记录但不参与离散率/失配统计，默认 false（参与） */
  excludedFromStats: boolean;
  /** 剔除原因（云影 / 仪器故障 / 其他人工备注） */
  excludeReason: string | null;
  createdAt: string;
}

/** 录入采集读数的表单草稿（离散率由系统计算；辐照度可留空表示缺失） */
export interface SampleDraft {
  stringId: string;
  sampledAt: string;
  currentA: number;
  voltageV: number;
  irradianceWm2: IrradianceValue;
}

/** 剔除原因选项（与云影复核场景对应） */
export type SampleExcludeReason = 'cloud' | 'device' | 'other';

export const SAMPLE_EXCLUDE_REASON_LABEL: Record<SampleExcludeReason, string> = {
  cloud: '云影遮挡',
  device: '仪器故障',
  other: '人工剔除',
};

/** 辐照度取值来源 */
export type IrradianceSource = 'measured' | 'peerMedian' | 'previous' | 'none';

export const IRRADIANCE_SOURCE_LABEL: Record<IrradianceSource, string> = {
  measured: '实测',
  peerMedian: '同箱中位数补全',
  previous: '上一条有效值沿用',
  none: '无可用值',
};

/** 离散率档位 */
export type DiscreteLevel = 'normal' | 'watch' | 'mismatch';

export const DISCRETE_LEVEL_LABEL: Record<DiscreteLevel, string> = {
  normal: '正常',
  watch: '关注',
  mismatch: '失配',
};

/** 采集行数据（带组串与设备上下文） */
export interface SampleRow extends Sample, Revisioned {
  stringCode: string;
  combinerBox: string;
  inverterId: string;
  inverterModel: string;
  arrayId: string;
  arrayCode: string;
  plantId: string;
  plantName: string;
  /** 实际用于归一化的辐照度（缺失时按同箱中位数 / 上一条有效值补全） */
  effectiveIrradianceWm2: number;
  /** 辐照度来源（实测 / 同箱中位数 / 上一条 / 无） */
  irradianceSource: IrradianceSource;
  /** 辐照度归一化后的电流（折算到 1000 W/m²） */
  normalizedCurrentA: number;
  /** 是否计入统计（剔除开关关闭 且 补全值未超过 30 分钟有效期） */
  countedInStats: boolean;
  /** 不计入统计的原因（人工剔除 / 补全辐照度过期） */
  uncountedReason: string | null;
}

/** 按组串聚合的统计结果，用于离散率榜 */
export interface StringDiscreteStat {
  stringId: string;
  stringCode: string;
  combinerBox: string;
  inverterId: string;
  arrayId: string;
  plantId: string;
  /** 全部采集点数（含被剔除与过期的读数，原始记录始终保留） */
  totalSampleCount: number;
  /** 实际参与统计的采集点数 */
  sampleCount: number;
  /** 被人工剔除的读数条数 */
  excludedCount: number;
  /** 因补全辐照度超过 30 分钟而退出统计的读数条数 */
  staleCount: number;
  avgCurrentA: number;
  avgNormalizedCurrentA: number;
  discreteRate: number;
  /** 相对同汇流箱均值的偏差百分比 */
  currentBiasPercent: number;
  level: DiscreteLevel;
  lastSampledAt: string;
}

/** 采集时间排序辅助 */
export function compareBySampledAt(a: Sample, b: Sample): number {
  return a.sampledAt.localeCompare(b.sampledAt);
}

/** 辐照度是否有效（null / 非正数均视为缺失） */
export function isValidIrradiance(value: IrradianceValue | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
