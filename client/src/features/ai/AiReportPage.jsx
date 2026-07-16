import { useState } from 'react';
import { Stack, Title, Group, Select, Button, Paper, Text, Loader, Alert, Typography, ActionIcon, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Download, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { notifications } from '../../utils/toast';
import { createAiJob, fetchAiJobs, deleteAiJob, downloadAiJob } from '../../api/ai';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import PageToolbar from '../../components/PageToolbar';
import FlexDateInput from '../../components/FlexDateInput';
import MonthInput from '../../components/MonthInput';
import Tag from '../../components/Tag';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// Keep in sync with AI_REPORT_TYPES / AI_TEAM_REPORT_ROLES in server/utils/constants.js - the
// server is the source of truth and re-validates both on every request, this is purely so the
// Select doesn't even offer an option the server would reject.
const REPORT_TYPES = [
  { value: 'performance', label: 'Performance Summary' },
  { value: 'pipeline', label: 'Sales Pipeline Analysis' },
  { value: 'financial', label: 'Financial / Revenue Report' },
  { value: 'team', label: 'Team Comparison' },
];
const REPORT_TYPE_LABELS = Object.fromEntries(REPORT_TYPES.map((t) => [t.value, t.label]));
const TEAM_REPORT_ROLES = ['admin', 'sales_head', 'teams_head', 'team_leader', 'backoffice'];

// The range TYPE (day/week/month) - paired with an actual date/month picker below so any day,
// week, or month can be reported on, not just the one ending today.
const RANGES = [
  { value: 'daily', label: 'Day' },
  { value: 'weekly', label: 'Week' },
  { value: 'monthly', label: 'Month' },
];

const FORMATS = [
  { value: 'md', label: 'Markdown' },
  { value: 'pdf', label: 'PDF' },
  { value: 'xlsx', label: 'Excel' },
];

const STATUS_COLOR = { pending: 'gray', processing: 'blue', completed: 'green', failed: 'red' };
const JOB_STATUS_LABEL = { pending: 'Queued...', processing: 'Generating...', completed: 'Ready', failed: 'Failed' };

function ReportRow({ report, expanded, onToggle, onDownload, onDelete, downloading, deleting }) {
  const canExpand = report.format === 'md' && report.status === 'completed' && !!report.content;
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group
          gap="xs"
          wrap="nowrap"
          style={{ flex: 1, minWidth: 0, cursor: canExpand ? 'pointer' : 'default' }}
          onClick={canExpand ? onToggle : undefined}
        >
          {canExpand && (expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />)}
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Group gap={6} wrap="wrap">
              <Text fw={600} size="sm">{report.title}</Text>
              <Tag size="xs">{REPORT_TYPE_LABELS[report.reportType] || report.reportType}</Tag>
              <Tag size="xs" color={STATUS_COLOR[report.status]}>{JOB_STATUS_LABEL[report.status] || report.status}</Tag>
            </Group>
            <Text size="xs" c="dimmed">{new Date(report.createdAt).toLocaleString()}</Text>
            {report.status === 'failed' && report.error && (
              <Text size="xs" c="red">{report.error}</Text>
            )}
          </Stack>
        </Group>

        <Group gap="xs" wrap="nowrap">
          {(report.status === 'pending' || report.status === 'processing') && <Loader size="xs" />}
          {report.status === 'completed' && (
            <Tooltip label={`Download ${FORMATS.find((f) => f.value === report.format)?.label || 'file'}`}>
              <ActionIcon variant="light" color="green" loading={downloading} onClick={() => onDownload(report)}>
                <Download size={16} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label="Delete report">
            <ActionIcon variant="light" color="red" loading={deleting} onClick={() => onDelete(report)}>
              <Trash2 size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {canExpand && expanded && (
        // Plain conditional render, not Mantine's <Collapse> - Collapse's height measurement is
        // broken with the installed @mantine/core + React 19 combo (reproduced directly: content
        // renders into the DOM but stays permanently pinned at height:0/display:none regardless
        // of the `in` prop, confirmed both in dev and in a production build). No animation this
        // way, but the content actually shows, which is the part that matters.
        <Paper withBorder p="lg" radius="md" mt="md">
          <Typography>
            <ReactMarkdown>{report.content}</ReactMarkdown>
          </Typography>
        </Paper>
      )}
    </Paper>
  );
}

// A real LLM-written narrative report, generated on the dedicated AI-Backend droplet (see
// ai-backend/ at the repo root). A 7B model on CPU-only hardware genuinely takes minutes, so this
// is a fire-and-poll flow, not a click-and-wait one - the Report History list below is what
// actually tracks generation, not the form itself.
export default function AiReportPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [reportType, setReportType] = useState('performance');
  const [range, setRange] = useState('daily');
  const [day, setDay] = useState(todayIso()); // anchor date for 'daily' (that day) and 'weekly' (the 7 days ending that day)
  const [month, setMonth] = useState(currentMonth()); // anchor month for 'monthly'
  const [format, setFormat] = useState('md');
  const [generating, setGenerating] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const reportTypeOptions = REPORT_TYPES.filter((t) => t.value !== 'team' || TEAM_REPORT_ROLES.includes(user.role));

  const listQuery = useQuery({
    queryKey: ['ai', 'jobs'],
    queryFn: fetchAiJobs,
    refetchInterval: (query) => {
      const jobs = query.state.data?.data || [];
      return jobs.some((j) => j.status === 'pending' || j.status === 'processing') ? 4000 : false;
    },
  });
  const reports = listQuery.data?.data || [];

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const date = range === 'monthly' ? `${month}-01` : day;
      await createAiJob({ period: range, date, format, reportType });
      queryClient.invalidateQueries({ queryKey: ['ai', 'jobs'] });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not start report', message: err.response?.data?.error || 'Something went wrong' });
    } finally {
      setGenerating(false);
    }
  };

  const handleDownload = async (report) => {
    setDownloadingId(report._id);
    try {
      const blob = await downloadAiJob(report.jobId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai-report-${report.jobId}.${report.format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Download failed', message: err.response?.data?.error || 'Something went wrong' });
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async (report) => {
    const ok = await confirm({
      title: 'Delete report?',
      message: `Permanently delete "${report.title}"? This cannot be undone.`,
      confirmLabel: 'Yes, delete',
      color: 'red',
    });
    if (!ok) return;
    setDeletingId(report._id);
    try {
      await deleteAiJob(report._id);
      queryClient.invalidateQueries({ queryKey: ['ai', 'jobs'] });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not delete report', message: err.response?.data?.error || 'Something went wrong' });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Stack>
      <PageToolbar title={<Title order={1} size="h3">AI Reports</Title>} />

      <Paper withBorder p="xl" radius="md">
        <Group gap="xs" mb={4}>
          <Sparkles size={18} />
          <Text fw={700} size="lg">Generate a Report</Text>
        </Group>
        <Text size="xs" c="dimmed" mb="md">
          A real LLM-written narrative report, grounded in your actual CRM data — takes a few minutes to generate.
        </Text>

        <Group align="flex-end">
          <Select label="Report Type" data={reportTypeOptions} value={reportType} onChange={(v) => v && setReportType(v)} w={220} disabled={generating} />
          <Select label="Range" data={RANGES} value={range} onChange={(v) => v && setRange(v)} w={130} disabled={generating} />
          {range === 'monthly' ? (
            <MonthInput label="Month" value={month} onChange={(v) => v && setMonth(v)} max={currentMonth()} w={170} disabled={generating} />
          ) : (
            <FlexDateInput
              label={range === 'weekly' ? '7 days ending' : 'Day'}
              value={day}
              onChange={(v) => v && setDay(v)}
              w={170}
              readOnly={generating}
            />
          )}
          <Select label="Format" data={FORMATS} value={format} onChange={(v) => v && setFormat(v)} w={150} disabled={generating} />
          <Button leftSection={<Sparkles size={16} />} onClick={handleGenerate} loading={generating}>
            Generate Report
          </Button>
        </Group>
      </Paper>

      <Stack gap="xs">
        <Group gap={6}>
          <Text fw={700} size="lg">Report History</Text>
          <Text size="xs" c="dimmed">(last 3 days)</Text>
        </Group>

        {listQuery.isLoading ? (
          <Text c="dimmed" size="sm">Loading...</Text>
        ) : reports.length === 0 ? (
          <Alert color="gray" variant="light">No reports generated in the last 3 days.</Alert>
        ) : (
          reports.map((r) => (
            <ReportRow
              key={r._id}
              report={r}
              expanded={expandedId === r._id}
              onToggle={() => setExpandedId(expandedId === r._id ? null : r._id)}
              onDownload={handleDownload}
              onDelete={handleDelete}
              downloading={downloadingId === r._id}
              deleting={deletingId === r._id}
            />
          ))
        )}
      </Stack>
    </Stack>
  );
}
