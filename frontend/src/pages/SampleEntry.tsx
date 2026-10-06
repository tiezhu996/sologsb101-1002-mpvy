/**
 * /samples 采集与离散率
 * 录入组串电流电压，实时计算离散率并标红越限；消费 Sample、String 与 <DiscreteBadge>。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useSampleStore } from '../stores/sampleStore';
import { useDeviceStore } from '../stores/deviceStore';
import type { SampleDraft, SampleRow as SampleViewRow, StringDiscreteStat } from '../types/sample';
import {
  IRRADIANCE_SOURCE_LABEL,
  SAMPLE_EXCLUDE_REASON_LABEL,
  type SampleExcludeReason,
} from '../types/sample';
import { normalizeCurrent } from '../utils/discrete';
import { FALLBACK_MAX_AGE_MIN } from '../utils/irradiance';
import { formatCurrent, formatIrradiance, formatPercent, formatVoltage, share } from '../utils/unit';
import DiscreteBadge from '../components/common/DiscreteBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import FilterBar, { useFilterValues, useKeywordFilter } from '../components/common/FilterBar';

interface SampleFormValues {
  stringId: string;
  sampledAt: dayjs.Dayjs;
  currentA: number;
  voltageV: number;
  /** 允许留空：辐照度缺失时由系统按同箱中位数 / 上一条有效值补全 */
  irradianceWm2: number | null;
}

interface BatchRow {
  key: string;
  stringId: string;
  label: string;
  currentA: number;
  voltageV: number;
}

export default function SampleEntry() {
  const { message } = AntdApp.useApp();
  const samples = useSampleStore((state) => state.samples);
  const stats = useSampleStore((state) => state.stats);
  const thresholds = useSampleStore((state) => state.thresholds);
  const sampleRows = useSampleStore((state) => state.sampleRows);
  const addSample = useSampleStore((state) => state.addSample);
  const addBatchSamples = useSampleStore((state) => state.addBatchSamples);
  const updateSample = useSampleStore((state) => state.updateSample);
  const deleteSample = useSampleStore((state) => state.deleteSample);
  const setSampleExcluded = useSampleStore((state) => state.setSampleExcluded);
  const toggleMark = useSampleStore((state) => state.toggleMark);
  const markedStringIds = useSampleStore((state) => state.markedStringIds);

  const strings = useDeviceStore((state) => state.strings);
  const inverters = useDeviceStore((state) => state.inverters);
  const arrays = useDeviceStore((state) => state.arrays);
  const plants = useDeviceStore((state) => state.plants);

  const keyword = useKeywordFilter();
  const filters = useFilterValues(['plant', 'inverter', 'level']);
  const [form] = Form.useForm<SampleFormValues>();
  const [excludeForm] = Form.useForm<{ reasonPreset: SampleExcludeReason; note: string }>();
  const [modal, setModal] = useState<{ open: boolean; editing: SampleViewRow | null }>({
    open: false,
    editing: null,
  });
  /** 剔除原因弹窗目标（null 表示关闭） */
  const [excludeTarget, setExcludeTarget] = useState<SampleViewRow | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchInverter, setBatchInverter] = useState<string>('');
  const [batchBox, setBatchBox] = useState<string>('');
  const [batchTime, setBatchTime] = useState<dayjs.Dayjs>(dayjs());
  const [batchIrradiance, setBatchIrradiance] = useState<number | null>(900);
  const [batchRows, setBatchRows] = useState<BatchRow[]>([]);
  const [onlySuspicious, setOnlySuspicious] = useState(false);
  /** 表格默认展示全部原始读数（含已剔除）；打开后只看计入统计的读数 */
  const [hideExcluded, setHideExcluded] = useState(false);

  const rows = sampleRows();
  const plantFilter = filters.plant ?? [];
  const inverterFilter = filters.inverter ?? [];
  const levelFilter = filters.level ?? [];

  const statOfString = useMemo(() => {
    const map = new Map<string, StringDiscreteStat>();
    for (const stat of stats) map.set(stat.stringId, stat);
    return map;
  }, [stats]);

  const filtered = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      if (hideExcluded && !row.countedInStats) return false;
      if (plantFilter.length > 0 && !plantFilter.includes(row.plantId)) return false;
      if (inverterFilter.length > 0 && !inverterFilter.includes(row.inverterId)) return false;
      const level = statOfString.get(row.stringId)?.level ?? 'normal';
      if (levelFilter.length > 0 && !levelFilter.includes(level)) return false;
      if (onlySuspicious && level === 'normal') return false;
      if (lower) {
        const haystack = [row.stringCode, row.combinerBox, row.inverterModel, row.arrayCode, row.plantName]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(lower)) return false;
      }
      return true;
    });
  }, [rows, keyword, plantFilter, inverterFilter, levelFilter, onlySuspicious, hideExcluded, statOfString]);

  const totals = useMemo(() => {
    const mismatch = stats.filter((stat) => stat.level === 'mismatch').length;
    const watch = stats.filter((stat) => stat.level === 'watch').length;
    const excluded = rows.filter((row) => !row.countedInStats).length;
    const avgRate =
      stats.length === 0
        ? 0
        : Number((stats.reduce((sum, stat) => sum + stat.discreteRate, 0) / stats.length).toFixed(2));
    return {
      samples: samples.length,
      strings: stats.length,
      mismatch,
      watch,
      excluded,
      avgRate,
      mismatchShare: share(mismatch, stats.length),
    };
  }, [stats, samples.length, rows]);

  /** 汇流箱候选（用于批量录入） */
  const boxOptions = useMemo(() => {
    const scope = batchInverter ? strings.filter((item) => item.inverterId === batchInverter) : strings;
    return [...new Set(scope.map((item) => item.combinerBox))].sort();
  }, [strings, batchInverter]);

  const openModal = (editing: SampleViewRow | null): void => {
    setModal({ open: true, editing });
    if (editing) {
      form.setFieldsValue({
        stringId: editing.stringId,
        sampledAt: dayjs(editing.sampledAt),
        currentA: editing.currentA,
        voltageV: editing.voltageV,
        irradianceWm2: editing.irradianceWm2,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({
        stringId: strings[0]?.id,
        sampledAt: dayjs(),
        currentA: 9,
        voltageV: 1080,
        irradianceWm2: 900,
      });
    }
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const draft: SampleDraft = {
      stringId: values.stringId,
      sampledAt: values.sampledAt.format('YYYY-MM-DD HH:mm'),
      currentA: values.currentA,
      voltageV: values.voltageV,
      // 留空（null）即辐照度缺失：系统按同箱中位数 → 上一条有效值补全
      irradianceWm2: values.irradianceWm2 === null ? null : Number(values.irradianceWm2),
    };
    if (modal.editing) {
      await updateSample(modal.editing.id, draft);
      message.success('采集记录已更新，离散率已按剩余读数重算');
    } else {
      await addSample(draft);
      const rate = statOfString.get(draft.stringId)?.discreteRate ?? 0;
      if (draft.irradianceWm2 === null) {
        message.info('辐照度缺失已登记：优先取同次同箱中位数，整箱都缺则沿用上一条有效值（30 分钟内）');
      }
      message.success(
        rate >= thresholds.discreteAlarmRate
          ? `已录入：该汇流箱离散率 ${rate}%，已达失配阈值，建议建处置单`
          : '采集记录已录入',
      );
    }
    setModal({ open: false, editing: null });
  };

  /** 打开剔除原因弹窗（云影为默认原因） */
  const openExclude = (row: SampleViewRow): void => {
    setExcludeTarget(row);
    excludeForm.setFieldsValue({ reasonPreset: 'cloud', note: row.excludeReason ?? '' });
  };

  const submitExclude = async (): Promise<void> => {
    if (!excludeTarget) return;
    const values = await excludeForm.validateFields();
    const presetText = SAMPLE_EXCLUDE_REASON_LABEL[values.reasonPreset];
    const note = values.note?.trim();
    const reason = note && note !== presetText ? `${presetText}：${note}` : presetText;
    await setSampleExcluded(excludeTarget.id, true, reason);
    message.success('已剔除该读数（原始记录保留），离散率榜与失配数已按剩余读数重算');
    setExcludeTarget(null);
    excludeForm.resetFields();
  };

  const restoreSample = async (row: SampleViewRow): Promise<void> => {
    await setSampleExcluded(row.id, false);
    message.success('已恢复计入统计，离散率榜与失配数已重算');
  };

  /** 依据汇流箱生成批量录入行 */
  const buildBatchRows = (): void => {
    if (!batchBox) {
      message.warning('请先选择汇流箱');
      return;
    }
    const scope = strings
      .filter((item) => item.combinerBox === batchBox && (!batchInverter || item.inverterId === batchInverter))
      .sort((a, b) => a.code.localeCompare(b.code));
    if (scope.length === 0) {
      message.warning('该汇流箱下没有组串');
      return;
    }
    setBatchRows(
      scope.map((item) => ({
        key: item.id,
        stringId: item.id,
        label: `${item.combinerBox} / ${item.code}`,
        currentA: 9,
        voltageV: Number((item.seriesCount * 41.6).toFixed(1)),
      })),
    );
  };

  const submitBatch = async (): Promise<void> => {
    if (batchRows.length === 0) {
      message.warning('请先生成待录入清单');
      return;
    }
    const drafts: SampleDraft[] = batchRows.map((row) => ({
      stringId: row.stringId,
      sampledAt: batchTime.format('YYYY-MM-DD HH:mm'),
      currentA: row.currentA,
      voltageV: row.voltageV,
      // 整批留空表示这批采集辐照仪未上报：由系统逐点按同箱中位数 / 上一条有效值补全
      irradianceWm2: batchIrradiance === null ? null : batchIrradiance,
    }));
    const created = await addBatchSamples(drafts);
    message.success(`已批量录入 ${created} 条采集记录并重算离散率`);
    setBatchRows([]);
    setBatchOpen(false);
  };

  /** 离散率榜（Top 8） */
  const rankList = useMemo(
    () => [...stats].sort((a, b) => b.discreteRate - a.discreteRate).slice(0, 8),
    [stats],
  );

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <Typography.Title level={4} className="gb-page-title">
            采集与离散率
          </Typography.Title>
          <Typography.Text type="secondary">
            按汇流箱录入组串电流电压，系统即时计算离散率并按阈值标红；云影读数可「不计入统计」但保留原始记录，辐照度缺失自动按同箱中位数 / 上一条有效值补全。
          </Typography.Text>
        </div>
        <Space wrap>
          <Space size={6}>
            <Typography.Text type="secondary">只看可疑</Typography.Text>
            <Switch checked={onlySuspicious} onChange={setOnlySuspicious} size="small" />
          </Space>
          <Space size={6}>
            <Typography.Text type="secondary">隐藏已剔除</Typography.Text>
            <Switch checked={hideExcluded} onChange={setHideExcluded} size="small" />
          </Space>
          <Button icon={<ThunderboltOutlined />} onClick={() => setBatchOpen(true)}>
            按汇流箱批量录入
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal(null)}>
            单点录入
          </Button>
        </Space>
      </div>

      <div className="gb-stat-grid">
        <StatBadge
          title="采集记录（原始保留）"
          value={totals.samples}
          suffix="条"
          color="#1668dc"
          hint={`其中 ${totals.excluded} 条不计入统计`}
        />
        <StatBadge title="在册统计组串" value={totals.strings} suffix="串" color="#0f7b6c" />
        <StatBadge
          title="平均离散率"
          value={totals.avgRate}
          suffix="%"
          color={totals.avgRate >= thresholds.discreteWatchRate ? '#d46b08' : '#237804'}
          hint={`关注 ≥ ${thresholds.discreteWatchRate}%，失配 ≥ ${thresholds.discreteAlarmRate}%（按剩余读数）`}
        />
        <StatBadge
          title="失配组串"
          value={totals.mismatch}
          suffix={`/ ${totals.strings}`}
          percent={totals.mismatchShare}
          color="#a8071a"
          hint={`关注档 ${totals.watch} 串；剔除 ${totals.excluded} 条后重算`}
        />
      </div>

      <FilterBar
        keywordPlaceholder="按组串 / 汇流箱 / 逆变器搜索"
        selects={[
          {
            key: 'plant',
            label: '电站',
            options: plants.map((item) => ({ label: item.name, value: item.id })),
            width: 200,
          },
          {
            key: 'inverter',
            label: '逆变器',
            options: inverters.map((item) => {
              const array = arrays.find((row) => row.id === item.arrayId);
              return { label: `${array?.code ?? '-'} / ${item.model}`, value: item.id };
            }),
            width: 200,
          },
          {
            key: 'level',
            label: '离散档位',
            options: [
              { label: '正常', value: 'normal' },
              { label: '关注', value: 'watch' },
              { label: '失配', value: 'mismatch' },
            ],
            width: 180,
          },
        ]}
        resultCount={filtered.length}
        countUnit="条采集"
      />

      <Row gutter={14} style={{ marginTop: 14 }}>
        <Col xs={24} xl={16}>
          <Card size="small" title="采集记录" styles={{ body: { padding: 12 } }}>
            {filtered.length === 0 ? (
              <EmptyPanel
                title="暂无采集记录"
                description="可单点录入，也可按汇流箱批量录入整箱组串数据。"
                createLabel="单点录入"
                onCreate={() => openModal(null)}
                extra={
                  <Button icon={<ThunderboltOutlined />} onClick={() => setBatchOpen(true)}>
                    批量录入
                  </Button>
                }
              />
            ) : (
              <Table
                rowKey="id"
                size="small"
                dataSource={filtered}
                pagination={{ pageSize: 10, size: 'small' }}
                scroll={{ x: 1420 }}
                rowClassName={(row) => (row.countedInStats ? '' : 'gb-sample-row is-excluded')}
                columns={[
                  { title: '采集时间', dataIndex: 'sampledAt', width: 140 },
                  {
                    title: '电站 / 方阵',
                    width: 190,
                    ellipsis: true,
                    render: (_, row) => `${row.plantName} / ${row.arrayCode}`,
                  },
                  { title: '组串', width: 140, render: (_, row) => `${row.combinerBox} · ${row.stringCode}` },
                  {
                    title: '原始电流',
                    dataIndex: 'currentA',
                    width: 100,
                    render: (value: number) => formatCurrent(value),
                  },
                  {
                    title: '辐照度 / 来源',
                    width: 190,
                    render: (_, row) => (
                      <Space size={4} direction="vertical" style={{ lineHeight: 1.2 }}>
                        <span>{formatIrradiance(row.irradianceWm2)}</span>
                        {row.irradianceSource === 'measured' ? null : (
                          <Tag
                            color={row.irradianceSource === 'previous' && !row.countedInStats ? 'red' : 'orange'}
                            style={{ marginInlineEnd: 0 }}
                          >
                            {IRRADIANCE_SOURCE_LABEL[row.irradianceSource]}
                          </Tag>
                        )}
                      </Space>
                    ),
                  },
                  {
                    title: '归一化电流',
                    dataIndex: 'normalizedCurrentA',
                    width: 120,
                    render: (value: number, row) =>
                      row.countedInStats ? (
                        formatCurrent(value)
                      ) : (
                        <span className="gb-hint">{formatCurrent(value)}（不计入）</span>
                      ),
                  },
                  {
                    title: '电压',
                    dataIndex: 'voltageV',
                    width: 100,
                    render: (value: number) => formatVoltage(value),
                  },
                  {
                    title: '离散率',
                    width: 160,
                    render: (_, row) => {
                      const stat = statOfString.get(row.stringId);
                      return (
                        <DiscreteBadge
                          rate={stat?.discreteRate ?? row.discreteRate}
                          thresholds={thresholds}
                          biasPercent={stat?.currentBiasPercent}
                          sampleCount={stat?.sampleCount}
                          size="small"
                        />
                      );
                    },
                  },
                  {
                    title: (
                      <Tooltip
                        title={`剔除后原始读数保留可查看，榜单与失配数按剩余读数重算；恢复计入同样自动重算。补全辐照度沿用超过 ${FALLBACK_MAX_AGE_MIN} 分钟自动退出统计。`}
                      >
                        <span>计入统计</span>
                      </Tooltip>
                    ),
                    width: 150,
                    render: (_, row) => {
                      if (!row.countedInStats && !row.excludedFromStats) {
                        // 补全辐照度过期自动退出统计：非人工剔除，需在 30 分钟有效期内补到实测值才会重新计入
                        return (
                          <Tooltip title={row.uncountedReason ?? '退出统计'}>
                            <Tag color="red" style={{ marginInlineEnd: 0 }}>
                              过期退出
                            </Tag>
                          </Tooltip>
                        );
                      }
                      if (!row.countedInStats) {
                        return (
                          <Tooltip title={row.uncountedReason ?? '不计入统计'}>
                            <Space size={4} direction="vertical" style={{ lineHeight: 1.2 }}>
                              <Switch
                                size="small"
                                checked={false}
                                onChange={() => void restoreSample(row)}
                              />
                              <Tag color="default" style={{ marginInlineEnd: 0 }}>
                                已剔除 · 可恢复
                              </Tag>
                            </Space>
                          </Tooltip>
                        );
                      }
                      return (
                        <Switch
                          size="small"
                          checked
                          onChange={() => openExclude(row)}
                          checkedChildren="计入"
                          unCheckedChildren="剔除"
                        />
                      );
                    },
                  },
                  {
                    title: '标记',
                    width: 90,
                    render: (_, row) => (
                      <Button
                        size="small"
                        type={markedStringIds.includes(row.stringId) ? 'primary' : 'default'}
                        onClick={() => toggleMark(row.stringId)}
                      >
                        {markedStringIds.includes(row.stringId) ? '已标记' : '标记'}
                      </Button>
                    ),
                  },
                  {
                    title: '操作',
                    width: 130,
                    fixed: 'right',
                    render: (_, row) => (
                      <Space size={2}>
                        <Button
                          size="small"
                          type="link"
                          icon={<EditOutlined />}
                          onClick={() => openModal(row)}
                        />
                        <Popconfirm
                          title="删除该条采集记录？"
                          okText="删除"
                          cancelText="取消"
                          onConfirm={async () => {
                            await deleteSample(row.id);
                            message.success('采集记录已删除');
                          }}
                        >
                          <Button size="small" type="link" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} xl={8}>
          <Card size="small" title="离散率榜（Top 8）" styles={{ body: { padding: 12 } }}>
            {rankList.length === 0 ? (
              <EmptyPanel title="暂无离散率数据" description="录入采集记录后自动计算。" />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {rankList.map((stat, index) => (
                  <div
                    key={stat.stringId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      borderBottom: '1px dashed rgba(0,0,0,0.08)',
                      paddingBottom: 6,
                    }}
                  >
                    <Space size={8}>
                      <Tag color={index === 0 ? 'red' : index < 3 ? 'orange' : 'default'}>#{index + 1}</Tag>
                      <span>
                        {stat.combinerBox} · {stat.stringCode}
                      </span>
                    </Space>
                    <Space size={6}>
                      <span className="gb-hint">{formatCurrent(stat.avgCurrentA)}</span>
                      <DiscreteBadge rate={stat.discreteRate} thresholds={thresholds} size="small" />
                    </Space>
                  </div>
                ))}
              </Space>
            )}
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              归一化基准辐照度 {thresholds.standardIrradiance} W/m²；电流偏差 ≥{' '}
              {thresholds.currentBiasPercent}% 判可疑；最少采集点数 {thresholds.minSampleCount}
              。榜单仅按「计入统计」的读数计算，剔除/过期读数保留在原始记录中。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>

      {/* 单点录入/编辑 */}
      <Drawer
        title={modal.editing ? '编辑采集记录' : '单点录入采集'}
        width={420}
        open={modal.open}
        onClose={() => setModal({ open: false, editing: null })}
        extra={
          <Space>
            <Button onClick={() => setModal({ open: false, editing: null })}>取消</Button>
            <Button type="primary" onClick={() => void submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item name="stringId" label="组串" rules={[{ required: true, message: '请选择组串' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={strings.map((item) => {
                const inverter = inverters.find((row) => row.id === item.inverterId);
                return {
                  label: `${item.combinerBox} / ${item.code}（${inverter?.model ?? '-'}）`,
                  value: item.id,
                };
              })}
            />
          </Form.Item>
          <Form.Item name="sampledAt" label="采集时间" rules={[{ required: true, message: '请选择采集时间' }]}>
            <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="currentA" label="电流（A）" rules={[{ required: true, message: '请输入电流' }]}>
            <InputNumber min={0} max={20} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="voltageV" label="电压（V）" rules={[{ required: true, message: '请输入电压' }]}>
            <InputNumber min={0} max={2000} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="irradianceWm2"
            label="辐照度（W/m²，可留空表示未上报）"
            extra="留空时系统优先取同次同汇流箱其他组串实测中位数；整箱都缺则沿用本组串上一条有效值，间隔超过 30 分钟退出统计。"
          >
            <InputNumber min={0} max={1400} step={10} style={{ width: '100%' }} placeholder="留空 = 辐照度缺失" />
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {() => {
              const current = Number(form.getFieldValue('currentA') ?? 0);
              const irradiance = form.getFieldValue('irradianceWm2');
              return (
                <Typography.Paragraph type="secondary">
                  {irradiance === null || irradiance === undefined
                    ? '辐照度缺失：归一化将使用补全值（同箱中位数 / 上一条有效值）'
                    : `归一化电流预览：${formatCurrent(normalizeCurrent(current, Number(irradiance), thresholds))}`}
                </Typography.Paragraph>
              );
            }}
          </Form.Item>
        </Form>
      </Drawer>

      {/* 批量录入 */}
      <Drawer
        title="按汇流箱批量录入"
        width={720}
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setBatchOpen(false)}>取消</Button>
            <Button type="primary" disabled={batchRows.length === 0} onClick={() => void submitBatch()}>
              提交 {batchRows.length} 条
            </Button>
          </Space>
        }
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            placeholder="选择逆变器"
            style={{ width: 220 }}
            allowClear
            value={batchInverter || undefined}
            onChange={(value) => {
              setBatchInverter(value ?? '');
              setBatchBox('');
              setBatchRows([]);
            }}
            options={inverters.map((item) => ({ label: item.model, value: item.id }))}
          />
          <Select
            placeholder="选择汇流箱"
            style={{ width: 160 }}
            value={batchBox || undefined}
            onChange={(value) => setBatchBox(value)}
            options={boxOptions.map((code) => ({ label: code, value: code }))}
          />
          <DatePicker
            showTime
            format="YYYY-MM-DD HH:mm"
            value={batchTime}
            onChange={(value) => setBatchTime(value ?? dayjs())}
          />
          <InputNumber
            min={0}
            max={1400}
            step={10}
            value={batchIrradiance}
            onChange={(value) => setBatchIrradiance(value === null ? null : Number(value))}
            addonAfter="W/m²"
            placeholder="留空=缺失"
          />
          <Button onClick={buildBatchRows}>生成清单</Button>
        </Space>

        {batchRows.length === 0 ? (
          <EmptyPanel
            title="尚未生成录入清单"
            description="选择汇流箱后点击「生成清单」，可逐串微调电流与电压。"
          />
        ) : (
          <Table<BatchRow>
            rowKey="key"
            size="small"
            pagination={false}
            dataSource={batchRows}
            columns={[
              { title: '组串', dataIndex: 'label', width: 180 },
              {
                title: '电流（A）',
                width: 150,
                render: (_, row) => (
                  <InputNumber
                    min={0}
                    max={20}
                    step={0.01}
                    value={row.currentA}
                    onChange={(value) =>
                      setBatchRows((prev) =>
                        prev.map((item) =>
                          item.key === row.key ? { ...item, currentA: Number(value ?? 0) } : item,
                        ),
                      )
                    }
                    style={{ width: '100%' }}
                  />
                ),
              },
              {
                title: '电压（V）',
                width: 150,
                render: (_, row) => (
                  <InputNumber
                    min={0}
                    max={2000}
                    step={0.1}
                    value={row.voltageV}
                    onChange={(value) =>
                      setBatchRows((prev) =>
                        prev.map((item) =>
                          item.key === row.key ? { ...item, voltageV: Number(value ?? 0) } : item,
                        ),
                      )
                    }
                    style={{ width: '100%' }}
                  />
                ),
              },
              {
                title: '归一化电流',
                width: 120,
                render: (_, row) =>
                  batchIrradiance === null
                    ? '按补全值计算'
                    : formatCurrent(normalizeCurrent(row.currentA, batchIrradiance, thresholds)),
              },
            ]}
          />
        )}

        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          提示：批量录入后系统按汇流箱分组重算离散率，离散率 = 组串归一化电流标准差 / 均值 × 100%，仅统计未剔除读数。
          辐照度留空时按「同箱中位数 → 上一条有效值（30 分钟内）」补全。当前可疑偏差阈值{' '}
          {formatPercent(thresholds.currentBiasPercent, 0)}。
        </Typography.Paragraph>
      </Drawer>

      {/* 剔除统计（云影复核）：保留原始记录，仅关闭统计开关，可随时恢复 */}
      <Modal
        title="剔除该读数（不计入统计）"
        open={Boolean(excludeTarget)}
        onCancel={() => setExcludeTarget(null)}
        onOk={() => void submitExclude()}
        okText="确认剔除"
        cancelText="取消"
      >
        {excludeTarget ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {excludeTarget.sampledAt} · {excludeTarget.combinerBox} · {excludeTarget.stringCode} · 原始电流{' '}
              {formatCurrent(excludeTarget.currentA)}
            </Typography.Text>
            <Typography.Paragraph type="warning" style={{ marginBottom: 0 }}>
              原始读数会完整保留并可查看，离散率榜与失配数立即按剩余读数重算；之后恢复计入同样自动重算。
            </Typography.Paragraph>
            <Form form={excludeForm} layout="vertical" style={{ marginTop: 4 }}>
              <Form.Item name="reasonPreset" label="剔除原因" rules={[{ required: true }]}>
                <Select
                  options={[
                    { label: SAMPLE_EXCLUDE_REASON_LABEL.cloud, value: 'cloud' },
                    { label: SAMPLE_EXCLUDE_REASON_LABEL.device, value: 'device' },
                    { label: SAMPLE_EXCLUDE_REASON_LABEL.other, value: 'other' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="note" label="备注（可选）">
                <Input.TextArea rows={2} placeholder="如：10:50-11:10 积云过境，与云图记录一致" />
              </Form.Item>
            </Form>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
