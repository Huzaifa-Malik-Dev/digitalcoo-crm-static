import { useState } from 'react';
import { Group, Button, Modal, Stack, FileInput, Text, ScrollArea, Alert, List } from '@mantine/core';
import { notifications } from '../utils/toast';
import { Download, Upload, TriangleAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// Shared Export/Import controls for any module that supports bulk spreadsheet access (DSR,
// Pipeline, Back Office, HR). Gated on user.importExportModules — a separate axis from view/edit,
// set by admin per-role/per-user in Admin > Permissions (see server/services/permissions.js).
// kind="xlsx" (default) is a plain spreadsheet; kind="zip" is a ZIP of data.xlsx + document files
// (used by HR, where records carry uploaded passport/visa/etc. images alongside the data fields).
export default function ImportExportBar({ moduleKey, filenamePrefix, exportFn, importFn, exportParams, onImported, kind = 'xlsx' }) {
  const { user } = useAuth();
  const [importOpen, setImportOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [importError, setImportError] = useState(null);

  if (!user.importExportModules?.includes(moduleKey)) return null;

  const ext = kind === 'zip' ? 'zip' : 'xlsx';
  const accept = kind === 'zip' ? '.zip' : '.xlsx,.xls,.csv';

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await exportFn(exportParams);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filenamePrefix}-export-${new Date().toISOString().slice(0, 10)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Export failed', message: err.response?.data?.error || 'Something went wrong' });
    } finally {
      setExporting(false);
    }
  };

  const openImport = () => {
    setFile(null);
    setResult(null);
    setImportError(null);
    setImportOpen(true);
  };

  const handleImport = async () => {
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      const { data } = await importFn(file);
      setResult(data);
      const successCount = data.created ?? data.updated ?? 0;
      const skippedNote = data.skipped ? `, ${data.skipped} already existed and were skipped` : '';
      if (data.failed === 0) {
        notifications.show({ color: 'green', message: `Import complete — ${successCount} row(s) processed${skippedNote}` });
        setImportOpen(false);
        onImported?.();
      } else if (successCount > 0 || data.skipped > 0) {
        notifications.show({ color: 'green', message: `Imported ${successCount} row(s)${skippedNote}, ${data.failed} failed — see details` });
        onImported?.();
      }
    } catch (err) {
      // Full detail (which can be long, e.g. "Date is missing on rows 2, 3, 4...") stays in the
      // modal where there's room to read and scroll it. The toast points there by name instead
      // of repeating (or worse, genericizing into "Something went wrong") the same message,
      // which would read like an unhandled crash rather than a specific, understood problem.
      setImportError(err.response?.data?.error || 'Something went wrong — please try again.');
      notifications.show({ color: 'red', title: 'Import failed', message: 'See details below.' });
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <Group gap="xs">
        <Button variant="filled" size="sm" leftSection={<Upload size={16} />} loading={exporting} onClick={handleExport}>
          Export
        </Button>
        <Button variant="filled" size="sm" leftSection={<Download size={16} />} onClick={openImport}>
          Import
        </Button>
      </Group>

      <Modal opened={importOpen} onClose={() => setImportOpen(false)} title={`Import ${filenamePrefix}`} size="md">
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {kind === 'zip'
              ? 'Upload a .zip file containing data.xlsx (and optionally document images/PDFs). For best results, start from an exported file and edit it — the column headers must match. Empty cells and unmatched documents leave existing data untouched.'
              : 'Upload an .xlsx, .xls, or .csv file. For best results, start from an exported file and edit it — the column headers must match.'}
          </Text>
          <FileInput placeholder="Choose file" accept={accept} value={file} onChange={setFile} clearable />
          <Button onClick={handleImport} loading={importing} disabled={!file}>
            Upload
          </Button>

          {importError && (
            <Alert color="red" icon={<TriangleAlert size={16} />} title="Import failed">
              <ScrollArea.Autosize mah={220} viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Import error, scrollable' }}>
                <Text size="sm">{importError}</Text>
              </ScrollArea.Autosize>
            </Alert>
          )}

          {result && (
            <Stack gap="xs">
              <Text size="sm">
                {result.total} row(s) read · {result.created ?? result.updated ?? 0} succeeded
                {result.skipped ? ` · ${result.skipped} already existed (skipped)` : ''} · {result.failed} failed
              </Text>
              {result.failed > 0 && (
                <Alert color="red" icon={<TriangleAlert size={16} />} title="Some rows could not be imported">
                  <ScrollArea.Autosize mah={220} viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Import errors, scrollable' }}>
                    <List size="sm" spacing={4}>
                      {result.errors.slice(0, 50).map((e, i) => (
                        <List.Item key={i}>Row {e.row}: {e.message}</List.Item>
                      ))}
                      {result.errors.length > 50 && (
                        <List.Item>… and {result.errors.length - 50} more</List.Item>
                      )}
                    </List>
                  </ScrollArea.Autosize>
                </Alert>
              )}
            </Stack>
          )}
        </Stack>
      </Modal>
    </>
  );
}
