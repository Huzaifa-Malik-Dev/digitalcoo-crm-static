import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Stack, TextInput, PasswordInput, NumberInput, Select, Button, Title, Group, Paper,
  SimpleGrid, ActionIcon, Text, Stepper, Divider, Textarea, SegmentedControl, FileButton,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '../../utils/toast';
import {
  ArrowLeft, User, AtSign, Lock, Briefcase, Building2, Users, Calendar, Target, Wallet, Mail, Phone,
  Globe, IdCard, Plane, Fingerprint, Landmark, ShieldCheck, Upload, X, Percent,
} from 'lucide-react';
import { createEmployee, fetchEmployees, uploadEmployeeDoc } from '../../api/hr';
import { useAuth } from '../../context/AuthContext';
import { ROLE_LABELS } from '../../constants/nav';
import { EMPTY_COMPLIANCE, LEGAL_CASE_STATUS, ABSCONDING_STATUS, isUnderage } from './complianceDefaults';
import { employeeUrlId } from './employeeUrl';
import { formatDate } from '../../utils/date';
import Tag from '../../components/Tag';

const ROLE_OPTIONS = Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }));
const PAY_TYPE_OPTIONS = [
  { value: 'salary', label: 'Salary Only' },
  { value: 'commission', label: 'Commission Only' },
  { value: 'salary_commission', label: 'Salary + Commission' },
];
const defUsername = (name) => name.toLowerCase().replace(/[^a-z]/g, '');
const LAST_STEP = 6;
const MAX_UPLOAD_MB = 5;

// One staged file slot on the Documents step — nothing uploads yet (there's no employee ID until
// the record is created), it just holds the picked File in local state until final submit.
function StagedFileField({ label, file, onPick, imageOnly }) {
  return (
    <div>
      <Text size="xs" c="dimmed" mb={4}>{label}</Text>
      <Group gap="xs" wrap="nowrap">
        <FileButton accept={imageOnly ? 'image/png,image/jpeg,image/webp' : 'image/png,image/jpeg,image/webp,application/pdf'} onChange={onPick}>
          {(props) => <Button {...props} size="compact-xs" variant="light" leftSection={<Upload size={12} />}>{file ? 'Replace' : 'Choose file'}</Button>}
        </FileButton>
        {file && (
          <>
            <Text size="xs" c="dimmed" maw={140} truncate="end">{file.name}</Text>
            <ActionIcon size="sm" variant="subtle" color="red" onClick={() => onPick(null)} aria-label="Remove file">
              <X size={14} />
            </ActionIcon>
          </>
        )}
      </Group>
    </div>
  );
}

// Multi-step wizard, not one long form — each step is a small, self-contained decision
// ("who is this person" / "where do they sit" / "how do we reach them" / their compliance
// paperwork) so it doesn't feel like a wall of fields. Every step's data stays in the same form
// instance, so Back never loses work. Each document's upload slot lives right next to the data
// fields for that same document (Passport scan under Passport No./Expiry, EID scan under EID
// No./Expiry, etc.) rather than being collected separately — picking a file just stages it
// locally (there's no employee ID to attach an upload to until the record exists), and every
// staged file uploads right after creation succeeds, in handleSubmit; from the agent's
// perspective it's still one continuous "Add Employee" action.
export default function AddEmployeePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canEdit = user.editModules?.includes('hr.addEmployee');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [active, setActive] = useState(0);
  const [stagedDocs, setStagedDocs] = useState({});

  const setDoc = (field, file) => {
    if (file && file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      notifications.show({ color: 'red', title: 'File too large', message: `${file.name} is over ${MAX_UPLOAD_MB}MB — please choose a smaller file.` });
      return;
    }
    setStagedDocs((prev) => ({ ...prev, [field]: file || undefined }));
  };

  const managersQuery = useQuery({ queryKey: ['hr', 'all-employees-for-select'], queryFn: () => fetchEmployees({ limit: 200 }) });
  const managerOptions = (managersQuery.data?.data || []).map((m) => ({ value: m._id, label: `${m.name} (${ROLE_LABELS[m.role] || m.role})` }));

  const form = useForm({
    initialValues: {
      name: '', arabicName: '', username: '', password: '', role: 'agent', email: '', phone: '',
      desig: '', dept: '', reportsTo: null, payType: 'salary', target: '', salary: '', join: new Date().toISOString().slice(0, 10),
      compliance: EMPTY_COMPLIANCE,
    },
    validate: {
      name: (v) => (v.trim().length ? null : 'Required'),
      username: (v) => (v.trim().length >= 3 ? null : 'At least 3 characters'),
      password: (v) => (v.length >= 6 ? null : 'At least 6 characters'),
      role: (v) => (v ? null : 'Required'),
    },
  });

  useEffect(() => {
    if (usernameTouched) return;
    form.setFieldValue('username', defUsername(form.values.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.name, usernameTouched]);

  const handleSubmit = async (values) => {
    try {
      const payload = {
        ...values,
        target: values.target === '' ? 0 : values.target,
        salary: values.salary === '' ? 0 : values.salary,
      };
      const res = await createEmployee(payload);
      const newId = res.data._id;

      // Documents can only upload once the employee record (and its ID) exists, so this happens
      // right after creation rather than as part of the create request itself — from the agent's
      // perspective it's still one continuous "Add Employee" action.
      const staged = Object.entries(stagedDocs).filter(([, file]) => file);
      if (staged.length) {
        const results = await Promise.allSettled(staged.map(([field, file]) => uploadEmployeeDoc(newId, field, file)));
        const failed = results.filter((r) => r.status === 'rejected').length;
        if (failed > 0) {
          notifications.show({
            color: 'yellow',
            title: 'Employee added, but some files failed',
            message: `${failed} of ${staged.length} document(s) couldn't be uploaded — you can retry from the employee's profile.`,
          });
        }
      }

      notifications.show({ color: 'green', message: `${values.name} added — employee ID ${res.data.employeeId}` });
      queryClient.invalidateQueries({ queryKey: ['hr'] });
      navigate(`/hr/employees/${employeeUrlId(res.data.employeeId)}?edit=1`);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not add employee', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const goNext = () => {
    if (active === 0) {
      const { hasErrors } = form.validate();
      if (hasErrors) return;
    }
    setActive((s) => Math.min(s + 1, LAST_STEP));
  };
  const goBack = () => setActive((s) => Math.max(s - 1, 0));

  if (!canEdit) {
    return (
      <Stack gap="md" maw={700}>
        <Group>
          <ActionIcon variant="subtle" onClick={() => navigate('/hr')} aria-label="Back to HR">
            <ArrowLeft size={18} />
          </ActionIcon>
          <Title order={1} size="h3">Add Employee</Title>
        </Group>
        <Text c="dimmed">You don't have permission to add employees.</Text>
      </Stack>
    );
  }

  const managerLabel = managerOptions.find((m) => m.value === form.values.reportsTo)?.label;
  const c = (field) => form.getInputProps(`compliance.${field}`);

  return (
    <Stack gap="md" maw={900} mx="auto">
      <Group>
        <ActionIcon variant="subtle" onClick={() => navigate('/hr')} aria-label="Back to HR">
          <ArrowLeft size={18} />
        </ActionIcon>
        <Title order={1} size="h3">Add Employee</Title>
      </Group>

      <Paper withBorder p="xl" radius="md">
        <form onSubmit={form.onSubmit(handleSubmit)}>
          <Stepper active={active} onStepClick={(i) => i < active && setActive(i)} size="sm">
            <Stepper.Step label="Login & Role" description="Who is this person">
              <Stack gap="md" mt="lg">
                <SimpleGrid cols={2}>
                  <TextInput label="Full Name" required leftSection={<User size={16} />} {...form.getInputProps('name')} />
                  <TextInput label="Arabic Name" leftSection={<User size={16} />} {...form.getInputProps('arabicName')} />
                  <Select label="Role" data={ROLE_OPTIONS} required leftSection={<Briefcase size={16} />} {...form.getInputProps('role')} />
                  <TextInput
                    label="Username"
                    required
                    leftSection={<AtSign size={16} />}
                    {...form.getInputProps('username')}
                    onChange={(e) => { setUsernameTouched(true); form.setFieldValue('username', e.currentTarget.value); }}
                  />
                  <PasswordInput label="Temporary Password" required leftSection={<Lock size={16} />} {...form.getInputProps('password')} />
                </SimpleGrid>
                <Divider label="Photo" labelPosition="left" />
                <StagedFileField label="Profile Picture (optional)" file={stagedDocs.profilePic} onPick={(f) => setDoc('profilePic', f)} imageOnly />
              </Stack>
            </Stepper.Step>

            <Stepper.Step label="Employment" description="Where they sit">
              <Stack gap="md" mt="lg">
                <SimpleGrid cols={2}>
                  <TextInput label="Designation" leftSection={<Briefcase size={16} />} {...form.getInputProps('desig')} />
                  <TextInput label="Department" leftSection={<Building2 size={16} />} {...form.getInputProps('dept')} />
                  <Select
                    label="Reports To"
                    placeholder="None (top of chain)"
                    data={managerOptions}
                    searchable
                    clearable
                    leftSection={<Users size={16} />}
                    {...form.getInputProps('reportsTo')}
                  />
                  <TextInput type="date" label="Join Date" leftSection={<Calendar size={16} />} {...form.getInputProps('join')} />
                  <Select
                    label="Pay Type"
                    data={PAY_TYPE_OPTIONS}
                    leftSection={<Percent size={16} />}
                    {...form.getInputProps('payType')}
                    onChange={(v) => {
                      form.setFieldValue('payType', v);
                      if (v === 'commission') form.setFieldValue('salary', 0);
                    }}
                  />
                  <NumberInput label="Monthly Target (AED)" min={0} leftSection={<Target size={16} />} {...form.getInputProps('target')} />
                  <NumberInput
                    label="Salary (AED)"
                    min={0}
                    leftSection={<Wallet size={16} />}
                    disabled={form.values.payType === 'commission'}
                    description={form.values.payType === 'commission' ? 'Not used for Commission Only pay' : undefined}
                    {...form.getInputProps('salary')}
                  />
                </SimpleGrid>
              </Stack>
            </Stepper.Step>

            <Stepper.Step label="Contact & Personal" description="How to reach them">
              <Stack gap="md" mt="lg">
                <SimpleGrid cols={2}>
                  <TextInput label="Email" leftSection={<Mail size={16} />} {...form.getInputProps('email')} />
                  <TextInput label="Phone" leftSection={<Phone size={16} />} {...form.getInputProps('phone')} />
                  <div>
                    <TextInput type="date" label="Date of Birth" leftSection={<Calendar size={16} />} {...c('dob')} />
                    {isUnderage(form.values.compliance.dob) && (
                      <Text size="xs" c="yellow.6" mt={4}>Employee is under 18 years old</Text>
                    )}
                  </div>
                  <TextInput label="Nationality" leftSection={<Globe size={16} />} {...c('nationality')} />
                  <TextInput label="UID (Unified Number)" leftSection={<IdCard size={16} />} {...c('uid')} />
                </SimpleGrid>
              </Stack>
            </Stepper.Step>

            <Stepper.Step label="Passport & Visa" description="Travel documents">
              <Stack gap="md" mt="lg">
                <Divider label="Passport" labelPosition="left" />
                <SimpleGrid cols={2}>
                  <TextInput label="Passport No." leftSection={<IdCard size={16} />} {...c('passportNo')} />
                  <TextInput type="date" label="Passport Expiry" leftSection={<Calendar size={16} />} {...c('passportExpiry')} />
                </SimpleGrid>
                <Group gap="xl">
                  <StagedFileField label="Front (optional)" file={stagedDocs.passportImgF} onPick={(f) => setDoc('passportImgF', f)} />
                  <StagedFileField label="Back (optional)" file={stagedDocs.passportImgB} onPick={(f) => setDoc('passportImgB', f)} />
                </Group>

                <Divider label="Visa" labelPosition="left" />
                <SimpleGrid cols={2}>
                  <TextInput label="Sponsor Company" leftSection={<Building2 size={16} />} {...c('visaCompany')} />
                  <TextInput label="Visa File Number" leftSection={<Plane size={16} />} {...c('visaFileNumber')} />
                  <TextInput type="date" label="Visa Issue Date" leftSection={<Calendar size={16} />} {...c('visaIssue')} />
                  <TextInput type="date" label="Visa Expiry" leftSection={<Calendar size={16} />} {...c('visaExpiry')} />
                </SimpleGrid>
                <Group gap="xl">
                  <StagedFileField label="Front (optional)" file={stagedDocs.visaImgF} onPick={(f) => setDoc('visaImgF', f)} />
                  <StagedFileField label="Back (optional)" file={stagedDocs.visaImgB} onPick={(f) => setDoc('visaImgB', f)} />
                </Group>
              </Stack>
            </Stepper.Step>

            <Stepper.Step label="Emirates ID & Labour Card" description="UAE identity documents">
              <Stack gap="md" mt="lg">
                <Divider label="Emirates ID" labelPosition="left" />
                <SimpleGrid cols={2}>
                  <TextInput label="Emirates ID No." leftSection={<Fingerprint size={16} />} {...c('eid')} />
                  <TextInput type="date" label="Issue Date" leftSection={<Calendar size={16} />} {...c('eidIssue')} />
                  <TextInput type="date" label="Expiry" leftSection={<Calendar size={16} />} {...c('eidExpiry')} />
                </SimpleGrid>
                <Group gap="xl">
                  <StagedFileField label="Front (optional)" file={stagedDocs.eidImgF} onPick={(f) => setDoc('eidImgF', f)} />
                  <StagedFileField label="Back (optional)" file={stagedDocs.eidImgB} onPick={(f) => setDoc('eidImgB', f)} />
                </Group>

                <Divider label="Labour Card (MOHRE)" labelPosition="left" />
                <SimpleGrid cols={2}>
                  <TextInput label="Labour Card No." leftSection={<Landmark size={16} />} {...c('labourCardNo')} />
                  <TextInput type="date" label="Issue Date" leftSection={<Calendar size={16} />} {...c('labourCardIssue')} />
                  <TextInput type="date" label="Expiry" leftSection={<Calendar size={16} />} {...c('labourCardExpiry')} />
                </SimpleGrid>
                <Group gap="xl">
                  <StagedFileField label="Front (optional)" file={stagedDocs.labourCardImg} onPick={(f) => setDoc('labourCardImg', f)} />
                </Group>
              </Stack>
            </Stepper.Step>

            <Stepper.Step label="Insurance & Compliance" description="Coverage & legal status">
              <Stack gap="md" mt="lg">
                <Divider label="Insurance" labelPosition="left" />
                <SimpleGrid cols={2}>
                  <TextInput type="date" label="Issue Date" leftSection={<ShieldCheck size={16} />} {...c('insuranceIssue')} />
                  <TextInput type="date" label="Expiry" leftSection={<Calendar size={16} />} {...c('insuranceExpiry')} />
                </SimpleGrid>
                <Group gap="xl">
                  <StagedFileField label="Front (optional)" file={stagedDocs.insuranceImgF} onPick={(f) => setDoc('insuranceImgF', f)} />
                  <StagedFileField label="Back (optional)" file={stagedDocs.insuranceImgB} onPick={(f) => setDoc('insuranceImgB', f)} />
                </Group>

                <Divider label="Legal Case" labelPosition="left" />
                <div>
                  <Text size="xs" c="dimmed" mb={4}>Has an active legal case?</Text>
                  <SegmentedControl data={LEGAL_CASE_STATUS} {...c('legalCaseStatus')} />
                </div>
                {form.values.compliance.legalCaseStatus === 'Yes' && (
                  <>
                    <Textarea label="Note" autosize minRows={1} {...c('legalCaseNote')} />
                    <StagedFileField label="Supporting document (optional)" file={stagedDocs.legalCaseDoc} onPick={(f) => setDoc('legalCaseDoc', f)} />
                  </>
                )}

                <Divider label="Absconding — MOHRE" labelPosition="left" />
                <div>
                  <Text size="xs" c="dimmed" mb={4}>Reported absconding to MOHRE?</Text>
                  <SegmentedControl data={ABSCONDING_STATUS} {...c('abscondingMohre')} />
                </div>
                {form.values.compliance.abscondingMohre === 'Yes' && (
                  <>
                    <Textarea label="Note" autosize minRows={1} {...c('abscondingMohreNote')} />
                    <StagedFileField label="Supporting document (optional)" file={stagedDocs.abscondingMohreDoc} onPick={(f) => setDoc('abscondingMohreDoc', f)} />
                  </>
                )}

                <Divider label="Absconding — GDRFA" labelPosition="left" />
                <div>
                  <Text size="xs" c="dimmed" mb={4}>Reported absconding to GDRFA?</Text>
                  <SegmentedControl data={ABSCONDING_STATUS} {...c('abscondingGdrfa')} />
                </div>
                {form.values.compliance.abscondingGdrfa === 'Yes' && (
                  <>
                    <Textarea label="Note" autosize minRows={1} {...c('abscondingGdrfaNote')} />
                    <StagedFileField label="Supporting document (optional)" file={stagedDocs.abscondingGdrfaDoc} onPick={(f) => setDoc('abscondingGdrfaDoc', f)} />
                  </>
                )}
              </Stack>
            </Stepper.Step>

            <Stepper.Completed>
              <Stack gap="md" mt="lg">
                <Text size="sm" c="dimmed">Review before adding — you can go back to any step to change something.</Text>
                <Divider label="Login & Role" labelPosition="left" />
                <SimpleGrid cols={2}>
                  <Text size="sm"><b>Name:</b> {form.values.name || '—'}</Text>
                  <Text size="sm"><b>Arabic Name:</b> {form.values.arabicName || '—'}</Text>
                  <Text size="sm"><b>Role:</b> <Tag>{ROLE_LABELS[form.values.role] || form.values.role}</Tag></Text>
                  <Text size="sm"><b>Username:</b> {form.values.username || '—'}</Text>
                </SimpleGrid>
                <Divider label="Employment" labelPosition="left" />
                <SimpleGrid cols={2}>
                  <Text size="sm"><b>Designation:</b> {form.values.desig || '—'}</Text>
                  <Text size="sm"><b>Department:</b> {form.values.dept || '—'}</Text>
                  <Text size="sm"><b>Reports To:</b> {managerLabel || 'None (top of chain)'}</Text>
                  <Text size="sm"><b>Join Date:</b> {formatDate(form.values.join) || '—'}</Text>
                  <Text size="sm"><b>Pay Type:</b> {PAY_TYPE_OPTIONS.find((o) => o.value === form.values.payType)?.label}</Text>
                  <Text size="sm"><b>Monthly Target:</b> AED {Number(form.values.target || 0).toLocaleString()}</Text>
                  <Text size="sm"><b>Salary:</b> AED {Number(form.values.salary || 0).toLocaleString()}</Text>
                </SimpleGrid>
                <Divider label="Contact & Personal" labelPosition="left" />
                <SimpleGrid cols={2}>
                  <Text size="sm"><b>Email:</b> {form.values.email || '—'}</Text>
                  <Text size="sm"><b>Phone:</b> {form.values.phone || '—'}</Text>
                  <Text size="sm"><b>Date of Birth:</b> {formatDate(form.values.compliance.dob) || '—'}</Text>
                  <Text size="sm"><b>Nationality:</b> {form.values.compliance.nationality || '—'}</Text>
                  <Text size="sm"><b>UID:</b> {form.values.compliance.uid || '—'}</Text>
                </SimpleGrid>
                <Divider label="Passport & Visa" labelPosition="left" />
                <SimpleGrid cols={2}>
                  <Text size="sm"><b>Passport No.:</b> {form.values.compliance.passportNo || '—'}</Text>
                  <Text size="sm"><b>Passport Expiry:</b> {form.values.compliance.passportExpiry || '—'}</Text>
                  <Text size="sm"><b>Sponsor Company:</b> {form.values.compliance.visaCompany || '—'}</Text>
                  <Text size="sm"><b>Visa File Number:</b> {form.values.compliance.visaFileNumber || '—'}</Text>
                  <Text size="sm"><b>Visa Issue:</b> {form.values.compliance.visaIssue || '—'}</Text>
                  <Text size="sm"><b>Visa Expiry:</b> {form.values.compliance.visaExpiry || '—'}</Text>
                </SimpleGrid>
                <Divider label="Emirates ID & Labour Card" labelPosition="left" />
                <SimpleGrid cols={2}>
                  <Text size="sm"><b>Emirates ID:</b> {form.values.compliance.eid || '—'}</Text>
                  <Text size="sm"><b>EID Issue / Expiry:</b> {form.values.compliance.eidIssue || '—'} / {form.values.compliance.eidExpiry || '—'}</Text>
                  <Text size="sm"><b>Labour Card No.:</b> {form.values.compliance.labourCardNo || '—'}</Text>
                  <Text size="sm"><b>Labour Card Issue / Expiry:</b> {form.values.compliance.labourCardIssue || '—'} / {form.values.compliance.labourCardExpiry || '—'}</Text>
                </SimpleGrid>
                <Divider label="Insurance & Compliance" labelPosition="left" />
                <SimpleGrid cols={2}>
                  <Text size="sm"><b>Insurance Issue / Expiry:</b> {form.values.compliance.insuranceIssue || '—'} / {form.values.compliance.insuranceExpiry || '—'}</Text>
                  <Text size="sm"><b>Legal Case:</b> {form.values.compliance.legalCaseStatus}</Text>
                  <Text size="sm"><b>Absconding (MOHRE):</b> {form.values.compliance.abscondingMohre}</Text>
                  <Text size="sm"><b>Absconding (GDRFA):</b> {form.values.compliance.abscondingGdrfa}</Text>
                </SimpleGrid>
                <Divider label="Documents" labelPosition="left" />
                <Text size="sm">
                  {Object.values(stagedDocs).filter(Boolean).length
                    ? `${Object.values(stagedDocs).filter(Boolean).length} file(s) attached — uploaded once you add the employee.`
                    : 'No files attached — you can add them later from the employee\'s profile.'}
                </Text>
              </Stack>
            </Stepper.Completed>
          </Stepper>

          <Group justify="space-between" mt="xl">
            <Button variant="default" onClick={goBack} disabled={active === 0}>Back</Button>
            {active < LAST_STEP ? (
              <Button onClick={goNext}>Next</Button>
            ) : (
              <Button type="submit">Add Employee</Button>
            )}
          </Group>
        </form>
      </Paper>
    </Stack>
  );
}
