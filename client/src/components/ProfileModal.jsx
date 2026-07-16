import { useState } from 'react';
import { Modal, Stack, TextInput, PasswordInput, Button, Divider, Text, Group } from '@mantine/core';
import { useForm } from '@mantine/form';
import { User, Lock } from 'lucide-react';
import { notifications } from '../utils/toast';
import { updateProfile } from '../api/auth';
import { useAuth } from '../context/AuthContext';

export default function ProfileModal({ opened, onClose }) {
  const { user, refresh } = useAuth();
  const [saving, setSaving] = useState(false);

  const nameForm = useForm({ initialValues: { name: user?.name || '' } });
  const passwordForm = useForm({
    initialValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
    validate: {
      newPassword: (v, values) => {
        if (!v && !values.currentPassword) return null;
        return v.length < 6 ? 'At least 6 characters' : null;
      },
      confirmPassword: (v, values) => (v !== values.newPassword ? "Passwords don't match" : null),
      currentPassword: (v, values) => (values.newPassword && !v ? 'Required to change password' : null),
    },
  });

  const handleClose = () => {
    passwordForm.reset();
    onClose();
  };

  const handleSaveName = async (values) => {
    if (values.name === user.name) return;
    setSaving(true);
    try {
      await updateProfile({ name: values.name });
      await refresh();
      notifications.show({ color: 'green', message: 'Name updated' });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update name', message: err.response?.data?.error || 'Something went wrong' });
    } finally {
      setSaving(false);
    }
  };

  const handleSavePassword = async (values) => {
    if (passwordForm.validate().hasErrors) return;
    setSaving(true);
    try {
      await updateProfile({ currentPassword: values.currentPassword, newPassword: values.newPassword });
      passwordForm.reset();
      notifications.show({ color: 'green', message: 'Password updated' });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update password', message: err.response?.data?.error || 'Something went wrong' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened={opened} onClose={handleClose} title="My Profile" size="sm">
      <Stack gap="lg" mt="xs">
        <Stack gap="xs">
          <Text size="xs" fw={600} c="dimmed" tt="uppercase">Username</Text>
          <TextInput value={user?.username || ''} readOnly disabled />
        </Stack>

        <Divider />

        <form onSubmit={nameForm.onSubmit(handleSaveName)}>
          <Stack gap="sm">
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">Display Name</Text>
            <TextInput leftSection={<User size={16} />} {...nameForm.getInputProps('name')} />
            <Group justify="flex-end">
              <Button
                type="submit"
                size="xs"
                variant="light"
                loading={saving}
                disabled={nameForm.values.name === user?.name || !nameForm.values.name.trim()}
              >
                Save Name
              </Button>
            </Group>
          </Stack>
        </form>

        <Divider />

        <form onSubmit={passwordForm.onSubmit(handleSavePassword)}>
          <Stack gap="sm">
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">Change Password</Text>
            <PasswordInput
              leftSection={<Lock size={16} />}
              placeholder="Current password"
              {...passwordForm.getInputProps('currentPassword')}
            />
            <PasswordInput
              leftSection={<Lock size={16} />}
              placeholder="New password"
              {...passwordForm.getInputProps('newPassword')}
            />
            <PasswordInput
              leftSection={<Lock size={16} />}
              placeholder="Confirm new password"
              {...passwordForm.getInputProps('confirmPassword')}
            />
            <Group justify="flex-end">
              <Button type="submit" size="xs" color="red" loading={saving}>
                Update Password
              </Button>
            </Group>
          </Stack>
        </form>
      </Stack>
    </Modal>
  );
}
