import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Stack, TextInput, NumberInput, Select, Button, Divider, Title, Text, Group, FileButton,
  SimpleGrid, Paper, Loader, Center, ActionIcon, Tooltip, Avatar, UnstyledButton, Modal, Image,
  SegmentedControl,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '../../utils/toast';
import { ArrowLeft, Upload, Pencil, Eye, Camera, Image as ImageIcon, FileText, Percent } from 'lucide-react';
import { fetchEmployeeByEmployeeId, updateEmployee, uploadEmployeeDoc } from '../../api/hr';
import { useAuth } from '../../context/AuthContext';
import { ROLE_LABELS } from '../../constants/nav';
import { docHealth } from './docHealth';
import { colorFor, initials } from '../../utils/avatar';
import { EMPTY_COMPLIANCE, LEGAL_CASE_STATUS, ABSCONDING_STATUS, isUnderage } from './complianceDefaults';
import EmployeeLedgerSection from './EmployeeLedgerSection';
import EmployeeCommissionTiersSection from './EmployeeCommissionTiersSection';
import { formatDate } from '../../utils/date';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';

const STATUS_OPTIONS = ['Active', 'Inactive', 'Frozen', 'Absconding'];
const ROLE_OPTIONS = Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }));
const PAY_TYPE_OPTIONS = [
  { value: 'salary', label: 'Salary Only' },
  { value: 'commission', label: 'Commission Only' },
  { value: 'salary_commission', label: 'Salary + Commission' },
];
const STATUS_COLOR = { Active: 'green', Inactive: 'gray', Frozen: 'blue', Absconding: 'red' };

const THUMB_SIZE = 200;
const MAX_UPLOAD_MB = 5;
const isPdfPath = (path) => /\.pdf(\?.*)?$/i.test(path || '');

// A bordered slot for one document image — dashed border + "No image" placeholder when nothing's
// uploaded yet (so a missing scan is visually obvious at a glance, not just an absent link), solid
// border with a thumbnail once one exists. Images open in the shared in-app quick-view Modal on
// click; PDFs open in a new tab instead since browsers already render those well on their own and
// embedding a PDF viewer in a small modal isn't worth it.
function DocThumb({ sideLabel, path, canEdit, onUpload, onPreview }) {
  const url = path ? `${import.meta.env.VITE_API_URL}${path}` : null;
  const pdf = isPdfPath(path);

  return (
    <Stack gap={6} align="center">
      <Text size="xs" c="dimmed">{sideLabel}</Text>
      <UnstyledButton
        onClick={() => { if (!url) return; if (pdf) window.open(url, '_blank', 'noopener'); else onPreview(url); }}
        style={{ cursor: url ? 'zoom-in' : 'default' }}
      >
        <Paper
          withBorder
          radius="md"
          w={THUMB_SIZE}
          h={THUMB_SIZE}
          style={{
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderStyle: url ? 'solid' : 'dashed',
          }}
        >
          {url ? (
            pdf ? (
              <Stack gap={4} align="center">
                <FileText size={32} />
                <Text size="xs" c="dimmed">PDF</Text>
              </Stack>
            ) : (
              <img src={url} alt={sideLabel} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            )
          ) : (
            <Stack gap={4} align="center">
              <ImageIcon size={32} color="var(--mantine-color-dimmed)" />
              <Text size="xs" c="dimmed">No image</Text>
            </Stack>
          )}
        </Paper>
      </UnstyledButton>
      {canEdit && (
        <FileButton accept="image/png,image/jpeg,image/webp,application/pdf" onChange={onUpload}>
          {(props) => <Button {...props} size="compact-xs" variant="light" leftSection={<Upload size={12} />}>{url ? 'Replace' : 'Upload'}</Button>}
        </FileButton>
      )}
    </Stack>
  );
}

// One document type, its own card — not a divider-separated block sharing a page-long stack with
// every other document. Each is self-contained: title + health badge, its own text fields, and its
// own Front/Back image slots, so nothing bleeds visually into the section above or below it.
function DocSection({ title, healthDate, fields, imgFieldF, imgFieldB, employeeId, imgPathF, imgPathB, canEdit, onUploaded, onPreview }) {
  const health = healthDate !== undefined ? docHealth(healthDate) : null;

  const uploadSide = async (field, sideLabel, file) => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      notifications.show({ color: 'red', title: 'File too large', message: `${file.name} is over ${MAX_UPLOAD_MB}MB — please choose a smaller file.` });
      return;
    }
    try {
      await uploadEmployeeDoc(employeeId, field, file);
      notifications.show({ color: 'green', message: `${title} (${sideLabel}) uploaded` });
      onUploaded();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Upload failed', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="sm">
        <Text size="sm" fw={700}>{title}</Text>
        {health && <Tag size="xs" color={health.color}>{health.label}</Tag>}
      </Group>
      <Stack gap="sm">
        <SimpleGrid cols={2}>
          {fields.map((f) => (
            <TextInput key={f.label} type={f.type} label={f.label} size="xs" readOnly={!canEdit} {...f.props} />
          ))}
        </SimpleGrid>
        {(imgFieldF || imgFieldB) && (
          <Group gap="xl">
            {imgFieldF && (
              <DocThumb sideLabel="Front" path={imgPathF} canEdit={canEdit} onUpload={(file) => uploadSide(imgFieldF, 'Front', file)} onPreview={onPreview} />
            )}
            {imgFieldB && (
              <DocThumb sideLabel="Back" path={imgPathB} canEdit={canEdit} onUpload={(file) => uploadSide(imgFieldB, 'Back', file)} onPreview={onPreview} />
            )}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

export default function EmployeeDetailPage() {
  const { employeeId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canEdit = user.editModules?.includes('hr');
  const editMode = searchParams.get('edit') === '1';
  // Viewing is always available; actually editing requires both hr edit access AND explicit edit mode.
  const editing = canEdit && editMode;

  const { data, isLoading } = useQuery({
    queryKey: ['hr', 'employee', employeeId],
    queryFn: () => fetchEmployeeByEmployeeId(employeeId),
  });
  const employee = data?.data;
  const [previewUrl, setPreviewUrl] = useState(null);

  const form = useForm({
    initialValues: {
      name: '', arabicName: '', desig: '', dept: '', email: '', phone: '', role: 'agent',
      payType: 'salary', target: '', salary: '', join: '', status: 'Active',
      compliance: EMPTY_COMPLIANCE,
    },
  });

  useEffect(() => {
    if (!employee) return;
    form.setValues({
      name: employee.name || '',
      arabicName: employee.arabicName || '',
      desig: employee.desig || '',
      dept: employee.dept || '',
      email: employee.email || '',
      phone: employee.phone || '',
      role: employee.role || 'agent',
      payType: employee.payType || 'salary',
      // 0 renders blank so an unset value doesn't need clearing before typing a real one -
      // coerced back to 0 on submit in handleSubmit if left blank.
      target: employee.target || '',
      salary: employee.salary || '',
      join: employee.join || '',
      status: employee.status || (employee.active !== false ? 'Active' : 'Inactive'),
      compliance: { ...EMPTY_COMPLIANCE, ...(employee.compliance || {}) },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee?._id]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['hr'] });

  const handleSubmit = async (values) => {
    try {
      const payload = {
        ...values,
        target: values.target === '' ? 0 : values.target,
        salary: values.salary === '' ? 0 : values.salary,
      };
      await updateEmployee(employee._id, payload);
      notifications.show({ color: 'green', message: 'Employee updated' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  if (isLoading) return <Center py="xl"><Loader size="sm" /></Center>;
  if (!employee) return <Text c="dimmed">Employee not found</Text>;

  // The URL now identifies the employee by employeeId, not the raw _id user.id is - resolve
  // the comparison against the fetched record instead of the route param.
  const isSelf = String(employee._id) === String(user.id);
  const docs = employee.docs || {};
  const currentStatus = employee.status || (employee.active !== false ? 'Active' : 'Inactive');

  const handleUploadProfilePic = async (file) => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      notifications.show({ color: 'red', title: 'File too large', message: `${file.name} is over ${MAX_UPLOAD_MB}MB — please choose a smaller file.` });
      return;
    }
    try {
      await uploadEmployeeDoc(employee._id, 'profilePic', file);
      notifications.show({ color: 'green', message: 'Profile picture updated' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Upload failed', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  // Single optional supporting document (Legal Case / Absconding) — unlike the Front/Back pairs
  // above, these are just one slot, uploaded only once the flag is set to "Yes".
  const handleUploadSingleDoc = async (field, label, file) => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      notifications.show({ color: 'red', title: 'File too large', message: `${file.name} is over ${MAX_UPLOAD_MB}MB — please choose a smaller file.` });
      return;
    }
    try {
      await uploadEmployeeDoc(employee._id, field, file);
      notifications.show({ color: 'green', message: `${label} uploaded` });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Upload failed', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  return (
    <Stack gap="md" w="100%">
      <PageToolbar
        title={
          <Group>
            <ActionIcon variant="subtle" onClick={() => navigate('/hr')} aria-label="Back to HR">
              <ArrowLeft size={18} />
            </ActionIcon>
            <div>
              <Title order={3}>{employee.name}</Title>
              <Group gap="xs">
                <Text size="sm" c="dimmed">{employee.employeeId}</Text>
                <Tag size="xs">{ROLE_LABELS[employee.role] || employee.role}</Tag>
                <Tag size="xs" color={STATUS_COLOR[currentStatus] || 'gray'}>{currentStatus}</Tag>
              </Group>
            </div>
          </Group>
        }
        actions={
          canEdit && (
            editing ? (
              <Button size="xs" variant="light" leftSection={<Eye size={14} />} onClick={() => setSearchParams({})}>
                Back to view
              </Button>
            ) : (
              <Button size="xs" variant="light" color="red" leftSection={<Pencil size={14} />} onClick={() => setSearchParams({ edit: '1' })}>
                Edit
              </Button>
            )
          )
        }
      />

      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Group align="flex-start" gap="md" wrap="wrap">
        <Stack gap="md" style={{ flex: '3 1 480px', minWidth: 320 }}>
          <Paper withBorder p="md" radius="md">
            <Divider label="Employment" labelPosition="left" mb="sm" />
            <SimpleGrid cols={2}>
              <TextInput label="Full Name" readOnly={!editing} {...form.getInputProps('name')} />
              <TextInput label="Arabic Name" readOnly={!editing} {...form.getInputProps('arabicName')} />
              <TextInput label="Designation" readOnly={!editing} {...form.getInputProps('desig')} />
              <TextInput label="Department" readOnly={!editing} {...form.getInputProps('dept')} />
              <TextInput type="date" label="Join Date" readOnly={!editing} {...form.getInputProps('join')} />
              <Tooltip label="You can't change your own role - ask another admin or HR" disabled={!isSelf}>
                <Select
                  label="Role"
                  data={ROLE_OPTIONS}
                  disabled={editing && isSelf}
                  readOnly={!editing}
                  {...form.getInputProps('role')}
                />
              </Tooltip>
              <Select
                label="Pay Type"
                data={PAY_TYPE_OPTIONS}
                readOnly={!editing}
                leftSection={<Percent size={16} />}
                {...form.getInputProps('payType')}
                onChange={(v) => {
                  form.setFieldValue('payType', v);
                  if (v === 'commission') form.setFieldValue('salary', 0);
                }}
              />
              <NumberInput label="Monthly Target (AED)" readOnly={!editing} {...form.getInputProps('target')} />
              <NumberInput
                label="Salary (AED)"
                readOnly={!editing}
                disabled={editing && form.values.payType === 'commission'}
                description={editing && form.values.payType === 'commission' ? 'Not used for Commission Only pay' : undefined}
                {...form.getInputProps('salary')}
              />
            </SimpleGrid>
            <Tooltip label="You can't change your own status - ask another admin or HR" disabled={!isSelf}>
              <Select
                mt="sm"
                label="Status"
                data={STATUS_OPTIONS}
                disabled={editing && isSelf}
                readOnly={!editing}
                maw={220}
                {...form.getInputProps('status')}
              />
            </Tooltip>
          </Paper>

          <Paper withBorder p="md" radius="md">
            <Divider label="Personal" labelPosition="left" mb="sm" />
            <SimpleGrid cols={2}>
              <TextInput label="Email" readOnly={!editing} {...form.getInputProps('email')} />
              <TextInput label="Phone" readOnly={!editing} {...form.getInputProps('phone')} />
              <div>
                <TextInput type="date" label="Date of Birth" readOnly={!editing} {...form.getInputProps('compliance.dob')} />
                {isUnderage(form.values.compliance.dob) && (
                  <Text size="xs" c="yellow.6" mt={4}>Employee is under 18 years old</Text>
                )}
              </div>
              <TextInput label="Nationality" readOnly={!editing} {...form.getInputProps('compliance.nationality')} />
              <TextInput label="UID (Unified Number)" readOnly={!editing} {...form.getInputProps('compliance.uid')} />
            </SimpleGrid>
          </Paper>

          <DocSection
            title="Passport"
            healthDate={form.values.compliance.passportExpiry}
            fields={[
              { label: 'No.', props: form.getInputProps('compliance.passportNo') },
              { label: 'Expiry', type: 'date', props: form.getInputProps('compliance.passportExpiry') },
            ]}
            imgFieldF="passportImgF"
            imgFieldB="passportImgB"
            employeeId={employee._id}
            imgPathF={docs.passportImgF}
            imgPathB={docs.passportImgB}
            canEdit={editing}
            onUploaded={refresh}
            onPreview={setPreviewUrl}
          />

          <DocSection
            title="Visa"
            healthDate={form.values.compliance.visaExpiry}
            fields={[
              { label: 'Sponsor Company', props: form.getInputProps('compliance.visaCompany') },
              { label: 'Visa File Number', props: form.getInputProps('compliance.visaFileNumber') },
              { label: 'Issue Date', type: 'date', props: form.getInputProps('compliance.visaIssue') },
              { label: 'Expiry', type: 'date', props: form.getInputProps('compliance.visaExpiry') },
            ]}
            imgFieldF="visaImgF"
            imgFieldB="visaImgB"
            employeeId={employee._id}
            imgPathF={docs.visaImgF}
            imgPathB={docs.visaImgB}
            canEdit={editing}
            onUploaded={refresh}
            onPreview={setPreviewUrl}
          />

          <DocSection
            title="Emirates ID"
            healthDate={form.values.compliance.eidExpiry}
            fields={[
              { label: 'No.', props: form.getInputProps('compliance.eid') },
              { label: 'Issue Date', type: 'date', props: form.getInputProps('compliance.eidIssue') },
              { label: 'Expiry', type: 'date', props: form.getInputProps('compliance.eidExpiry') },
            ]}
            imgFieldF="eidImgF"
            imgFieldB="eidImgB"
            employeeId={employee._id}
            imgPathF={docs.eidImgF}
            imgPathB={docs.eidImgB}
            canEdit={editing}
            onUploaded={refresh}
            onPreview={setPreviewUrl}
          />

          <DocSection
            title="Labour Card (MOHRE)"
            healthDate={form.values.compliance.labourCardExpiry}
            fields={[
              { label: 'No.', props: form.getInputProps('compliance.labourCardNo') },
              { label: 'Issue Date', type: 'date', props: form.getInputProps('compliance.labourCardIssue') },
              { label: 'Expiry', type: 'date', props: form.getInputProps('compliance.labourCardExpiry') },
            ]}
            imgFieldF="labourCardImg"
            employeeId={employee._id}
            imgPathF={docs.labourCardImg}
            canEdit={editing}
            onUploaded={refresh}
            onPreview={setPreviewUrl}
          />

          <DocSection
            title="Insurance"
            healthDate={form.values.compliance.insuranceExpiry}
            fields={[
              { label: 'Issue Date', type: 'date', props: form.getInputProps('compliance.insuranceIssue') },
              { label: 'Expiry', type: 'date', props: form.getInputProps('compliance.insuranceExpiry') },
            ]}
            imgFieldF="insuranceImgF"
            imgFieldB="insuranceImgB"
            employeeId={employee._id}
            imgPathF={docs.insuranceImgF}
            imgPathB={docs.insuranceImgB}
            canEdit={editing}
            onUploaded={refresh}
            onPreview={setPreviewUrl}
          />

          <Paper withBorder p="md" radius="md">
            <Divider label="Legal Case" labelPosition="left" mb="sm" />
            <Stack gap="sm">
              <div>
                <Text size="xs" c="dimmed" mb={4}>Has an active legal case?</Text>
                <SegmentedControl data={LEGAL_CASE_STATUS} disabled={!editing} {...form.getInputProps('compliance.legalCaseStatus')} />
              </div>
              {form.values.compliance.legalCaseStatus === 'Yes' && (
                <>
                  <TextInput label="Note" readOnly={!editing} {...form.getInputProps('compliance.legalCaseNote')} />
                  <Group>
                    <DocThumb
                      sideLabel="Document (optional)"
                      path={docs.legalCaseDoc}
                      canEdit={editing}
                      onUpload={(file) => handleUploadSingleDoc('legalCaseDoc', 'Legal Case document', file)}
                      onPreview={setPreviewUrl}
                    />
                  </Group>
                </>
              )}
            </Stack>
          </Paper>

          <Paper withBorder p="md" radius="md">
            <Divider label="Absconding — MOHRE" labelPosition="left" mb="sm" />
            <Stack gap="sm">
              <div>
                <Text size="xs" c="dimmed" mb={4}>Reported absconding to MOHRE?</Text>
                <SegmentedControl data={ABSCONDING_STATUS} disabled={!editing} {...form.getInputProps('compliance.abscondingMohre')} />
              </div>
              {form.values.compliance.abscondingMohre === 'Yes' && (
                <>
                  <TextInput label="Note" readOnly={!editing} {...form.getInputProps('compliance.abscondingMohreNote')} />
                  <Group>
                    <DocThumb
                      sideLabel="Document (optional)"
                      path={docs.abscondingMohreDoc}
                      canEdit={editing}
                      onUpload={(file) => handleUploadSingleDoc('abscondingMohreDoc', 'Absconding MOHRE document', file)}
                      onPreview={setPreviewUrl}
                    />
                  </Group>
                </>
              )}
            </Stack>
          </Paper>

          <Paper withBorder p="md" radius="md">
            <Divider label="Absconding — GDRFA" labelPosition="left" mb="sm" />
            <Stack gap="sm">
              <div>
                <Text size="xs" c="dimmed" mb={4}>Reported absconding to GDRFA?</Text>
                <SegmentedControl data={ABSCONDING_STATUS} disabled={!editing} {...form.getInputProps('compliance.abscondingGdrfa')} />
              </div>
              {form.values.compliance.abscondingGdrfa === 'Yes' && (
                <>
                  <TextInput label="Note" readOnly={!editing} {...form.getInputProps('compliance.abscondingGdrfaNote')} />
                  <Group>
                    <DocThumb
                      sideLabel="Document (optional)"
                      path={docs.abscondingGdrfaDoc}
                      canEdit={editing}
                      onUpload={(file) => handleUploadSingleDoc('abscondingGdrfaDoc', 'Absconding GDRFA document', file)}
                      onPreview={setPreviewUrl}
                    />
                  </Group>
                </>
              )}
            </Stack>
          </Paper>

          {editing && <Button type="submit">Save Changes</Button>}
        </Stack>

        <Stack gap="md" style={{ flex: '1 1 260px', minWidth: 240, maxWidth: 280 }}>
          <Paper withBorder p="md" radius="md">
            <Stack align="center" gap="sm">
              <UnstyledButton
                onClick={() => docs.profilePic && setPreviewUrl(`${import.meta.env.VITE_API_URL}${docs.profilePic}`)}
                style={{ cursor: docs.profilePic ? 'zoom-in' : 'default' }}
              >
                <Avatar
                  size={140}
                  radius="md"
                  color={colorFor(employee.name)}
                  src={docs.profilePic ? `${import.meta.env.VITE_API_URL}${docs.profilePic}` : null}
                >
                  {!docs.profilePic && initials(employee.name)}
                </Avatar>
              </UnstyledButton>
              {editing && (
                <FileButton accept="image/png,image/jpeg,image/webp" onChange={handleUploadProfilePic}>
                  {(props) => (
                    <Button {...props} size="xs" variant="light" fullWidth leftSection={<Camera size={14} />}>
                      Change Photo
                    </Button>
                  )}
                </FileButton>
              )}
            </Stack>
          </Paper>

          <Paper withBorder p="md" radius="md">
            <Stack gap="sm">
              <div>
                <Text size="xs" c="dimmed">Employee ID</Text>
                <Text size="sm" fw={600}>{employee.employeeId}</Text>
              </div>
              <div>
                <Text size="xs" c="dimmed">Role</Text>
                <Text size="sm">{ROLE_LABELS[employee.role] || employee.role}</Text>
              </div>
              <div>
                <Text size="xs" c="dimmed">Status</Text>
                <Tag size="sm" color={STATUS_COLOR[currentStatus] || 'gray'}>{currentStatus}</Tag>
              </div>
              <div>
                <Text size="xs" c="dimmed">Department</Text>
                <Text size="sm">{employee.dept || '—'}</Text>
              </div>
              <div>
                <Text size="xs" c="dimmed">Join Date</Text>
                <Text size="sm">{formatDate(employee.join) || '—'}</Text>
              </div>
            </Stack>
          </Paper>
        </Stack>
        </Group>
      </form>

      {employee.payType !== 'salary' && (
        <EmployeeCommissionTiersSection
          employeeId={employee._id}
          canEdit={user.editModules?.includes('payroll.commissionTiers')}
        />
      )}

      <EmployeeLedgerSection employeeId={employee._id} />

      <Modal opened={!!previewUrl} onClose={() => setPreviewUrl(null)} size="lg" centered title="Document Preview">
        {previewUrl && <Image src={previewUrl} fit="contain" mah="75vh" radius="sm" />}
      </Modal>
    </Stack>
  );
}
