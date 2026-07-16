import { useState } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { Paper, Title, TextInput, PasswordInput, Button, Stack, Center, Text, ActionIcon, useMantineColorScheme, useComputedColorScheme } from '@mantine/core';
import { notifications } from '../../utils/toast';
import { Sun, Moon } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { setColorScheme } = useMantineColorScheme();
  const computedColorScheme = useComputedColorScheme('dark');

  if (user) return <Navigate to="/" replace />;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await login(username, password);
      navigate(location.state?.from?.pathname || '/', { replace: true });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Login failed',
        message: err.response?.data?.error || 'Invalid username or password',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Center h="100vh">
      <ActionIcon
        variant="default"
        size="lg"
        style={{ position: 'absolute', top: 16, right: 16 }}
        onClick={() => setColorScheme(computedColorScheme === 'dark' ? 'light' : 'dark')}
        aria-label="Toggle color scheme"
      >
        {computedColorScheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </ActionIcon>
      <Paper withBorder shadow="md" p={32} radius="md" w={380}>
        <Stack gap="lg">
          <Stack align="center" gap={4}>
            <img src="/logo-mark.png" alt="Digitalcoo" width={72} height={72} style={{ objectFit: 'contain' }} />
            <Title order={2} mt={4}>Digitalcoo CRM</Title>
            <Text c="dimmed" size="sm">Sign in to continue</Text>
          </Stack>
          <form onSubmit={handleSubmit}>
            <Stack gap="md">
              <TextInput
                label="Username"
                placeholder=""
                value={username}
                onChange={(e) => setUsername(e.currentTarget.value)}
                required
                autoFocus
              />
              <PasswordInput
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                required
              />
              <Button type="submit" loading={submitting} fullWidth mt="sm">
                Sign in
              </Button>
            </Stack>
          </form>
        </Stack>
      </Paper>
    </Center>
  );
}
