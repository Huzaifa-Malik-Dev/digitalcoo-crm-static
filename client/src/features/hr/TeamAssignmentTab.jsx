import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Stack, Paper, Group, Select, Badge, Text, Loader, Center, Accordion, Avatar, Box, Modal, TextInput, Button } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { fetchEmployees, updateEmployee } from '../../api/hr';
import { colorFor, initials } from '../../utils/avatar';
import { employeeUrlId } from './employeeUrl';

const today = () => new Date().toISOString().slice(0, 10);

// A curated, hand-ordered subset of Mantine's palette for Team Leader color-coding - deliberately
// NOT the same colorFor() used for avatars. Avatars are small solid circles where any of
// Mantine's 10 colors reads fine; here the color has to stay distinguishable as a large tinted
// card background in dark mode, where neighbors like grape/violet/indigo/pink desaturate into
// near-identical muted purples. This list alternates warm/cool hues so adjacent Team Leaders
// (the ones actually compared side by side in the list) are always visually far apart, and
// assignment is by stable list position, not a name hash, so it can't coincidentally pick two
// similar neighbors the way colorFor() sometimes does.
const TL_COLORS = ['blue', 'orange', 'teal', 'red', 'grape', 'yellow', 'cyan', 'pink', 'lime', 'indigo'];

// A flat light tint (Mantine's `-light` var) reads as barely-there in dark mode - blending a
// stronger percentage of the solid color into the actual surface color gives a background that's
// unmistakably that color while staying a normal, theme-correct surface (not a translucent
// overlay). The solid left border adds a second, sharper cue on top for quick scanning.
function tlSwatchStyle(color, { bold = false } = {}) {
  return {
    backgroundColor: `color-mix(in srgb, var(--mantine-color-${color}-6) ${bold ? 28 : 16}%, var(--mantine-color-body))`,
    borderLeft: `4px solid var(--mantine-color-${color}-6)`,
  };
}

// Full reporting chain this app has: Sales Head -> Teams Head -> Team Leader -> Agent.
// Rendered as a tree (Teams Head as the expandable top level, indentation shows depth) so the
// whole org shows at a glance instead of one flat "agent -> TL" list with no way to move
// Team Leaders between Teams Heads.
function PersonLabel({ person, navigate, size = 'sm' }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Avatar size={size === 'sm' ? 22 : 26} radius="xl" color={colorFor(person.name)}>{initials(person.name)}</Avatar>
      <div>
        <Text
          size={size}
          fw={600}
          style={{ cursor: 'pointer' }}
          onClick={() => navigate(`/hr/employees/${employeeUrlId(person.employeeId)}`)}
          title="Open profile"
        >
          {person.name}
        </Text>
        {person.desig && <Text size="xs" c="dimmed">{person.desig}</Text>}
      </div>
    </Group>
  );
}

export default function TeamAssignmentTab({ canEdit }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(null); // { person, newManagerId, newManagerName, levelLabel }
  const [effectiveDate, setEffectiveDate] = useState(today());
  const [submitting, setSubmitting] = useState(false);

  const thQuery = useQuery({ queryKey: ['hr', 'teams-heads'], queryFn: () => fetchEmployees({ role: 'teams_head', limit: 200 }) });
  const tlQuery = useQuery({ queryKey: ['hr', 'team-leaders'], queryFn: () => fetchEmployees({ role: 'team_leader', limit: 200 }) });
  const agentQuery = useQuery({ queryKey: ['hr', 'agents'], queryFn: () => fetchEmployees({ role: 'agent', limit: 200 }) });

  if (thQuery.isLoading || tlQuery.isLoading || agentQuery.isLoading) {
    return <Center py="xl"><Loader size="sm" /></Center>;
  }

  const teamsHeads = thQuery.data?.data || [];
  const teamLeaders = tlQuery.data?.data || [];
  const agents = agentQuery.data?.data || [];

  const thOptions = teamsHeads.map((th) => ({ value: th._id, label: th.name }));
  // Stable index-based assignment (not a name hash) so colors stay maximally distinct across
  // however many TLs actually exist, and the same TL always gets the same color everywhere on
  // this page (card, nested agents, and every dropdown option that references them).
  const tlColorById = Object.fromEntries(teamLeaders.map((tl, i) => [String(tl._id), TL_COLORS[i % TL_COLORS.length]]));
  // Each Team Leader gets that color in the dropdown too (same one used on their card below), so
  // picking a name visually matches the card it'll move the agent into - a compact swap for
  // spelling out "under <Teams Head>" in every row, which reads as clutter once you have more
  // than a couple of TLs. The team name ("Team C") is pulled from desig's "Role — Team X"
  // convention when present, since that's the short label already shown under the TL's name.
  const tlOptions = teamLeaders.map((tl) => {
    const team = tl.desig && tl.desig.includes('—') ? tl.desig.split('—').pop().trim() : null;
    return { value: tl._id, label: team ? `${tl.name} (${team})` : tl.name, color: tlColorById[String(tl._id)] };
  });
  const renderTlOption = ({ option }) => (
    <Group gap="xs" wrap="nowrap" w="100%" p={6} style={{ ...tlSwatchStyle(option.color, { bold: true }), borderRadius: 4 }}>
      <Text size="sm">{option.label}</Text>
    </Group>
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['hr'] });

  // Opens the confirm+date modal instead of reassigning right away - the assignment date is
  // required (see reassignSchema server-side) so it can't be skipped by closing early.
  const handleReassign = (person, newManagerId, newManagerName, levelLabel) => {
    setEffectiveDate(today());
    setPending({ person, newManagerId, newManagerName, levelLabel });
  };

  const confirmReassign = async () => {
    if (!pending || !effectiveDate) return;
    setSubmitting(true);
    try {
      await updateEmployee(pending.person._id, { reportsTo: pending.newManagerId, effectiveDate });
      notifications.show({ color: 'green', message: `${pending.person.name} now reports to ${pending.newManagerName}` });
      setPending(null);
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not reassign', message: err.response?.data?.error || 'Something went wrong' });
    } finally {
      setSubmitting(false);
    }
  };

  const unassignedTLs = teamLeaders.filter((tl) => !tl.reportsTo);
  const unassignedAgents = agents.filter((a) => !a.reportsTo);

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        The full reporting chain: Teams Head → Team Leader → Agent. Click a name to open their profile, or use the dropdown to move them under a different manager.
      </Text>

      {teamsHeads.length === 0 ? (
        <Text size="sm" c="dimmed">No Teams Heads yet.</Text>
      ) : (
        <Accordion multiple defaultValue={teamsHeads.map((th) => th._id)} variant="separated" radius="md">
          {teamsHeads.map((th) => {
            const myTLs = teamLeaders.filter((tl) => String(tl.reportsTo) === String(th._id));
            const tlIds = new Set(myTLs.map((tl) => String(tl._id)));
            const agentCount = agents.filter((a) => tlIds.has(String(a.reportsTo))).length;
            return (
              <Accordion.Item key={th._id} value={th._id}>
                <Accordion.Control>
                  <Group justify="space-between" pr="sm" wrap="nowrap">
                    <PersonLabel person={th} navigate={navigate} />
                    <Group gap={6} wrap="nowrap">
                      <Badge variant="light" size="sm">{myTLs.length} team leader{myTLs.length === 1 ? '' : 's'}</Badge>
                      <Badge variant="light" color="gray" size="sm">{agentCount} agent{agentCount === 1 ? '' : 's'}</Badge>
                    </Group>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="sm" pl="md" style={{ borderLeft: '2px solid var(--mantine-color-default-border)' }}>
                    {myTLs.length === 0 && <Text size="sm" c="dimmed">No team leaders assigned to this Teams Head yet.</Text>}
                    {myTLs.length > 0 && (
                      <Accordion multiple defaultValue={[]} variant="separated" radius="md">
                        {myTLs.map((tl) => {
                          const myAgents = agents.filter((a) => String(a.reportsTo) === String(tl._id));
                          const tlColor = tlColorById[String(tl._id)];
                          return (
                            <Accordion.Item key={tl._id} value={tl._id} style={tlSwatchStyle(tlColor, { bold: true })}>
                              <Group wrap="nowrap" gap="xs" align="center" pr="sm">
                                <Accordion.Control style={{ flex: 1 }}>
                                  <Group justify="space-between" wrap="nowrap">
                                    <PersonLabel person={tl} navigate={navigate} />
                                    <Badge variant="light" size="xs">{myAgents.length} agent{myAgents.length === 1 ? '' : 's'}</Badge>
                                  </Group>
                                </Accordion.Control>
                                {canEdit && (
                                  <Select
                                    label="Reports to (Teams Head)"
                                    data={thOptions}
                                    value={th._id}
                                    onChange={(v) => v && v !== th._id && handleReassign(tl, v, thOptions.find((o) => o.value === v)?.label, 'Teams Head')}
                                    size="xs"
                                    w={190}
                                    aria-label={`Reassign ${tl.name} to a different Teams Head`}
                                  />
                                )}
                              </Group>
                              <Accordion.Panel>
                                <Box
                                  pl="md"
                                  py={myAgents.length ? 'xs' : 0}
                                  style={{
                                    borderLeft: `2px dashed var(--mantine-color-${tlColor}-6)`,
                                    backgroundColor: myAgents.length
                                      ? `color-mix(in srgb, var(--mantine-color-${tlColor}-6) 10%, var(--mantine-color-body))`
                                      : 'transparent',
                                    borderRadius: 6,
                                  }}
                                >
                                  <Stack gap={8}>
                                    {myAgents.length === 0 && <Text size="xs" c="dimmed">No agents assigned to this Team Leader yet.</Text>}
                                    {myAgents.map((agent) => (
                                      <Group key={agent._id} justify="space-between" wrap="nowrap">
                                        <PersonLabel person={agent} navigate={navigate} size="xs" />
                                        {canEdit && (
                                          <Select
                                            label="Reports to (Team Leader)"
                                            data={tlOptions}
                                            value={tl._id}
                                            onChange={(v) => v && v !== tl._id && handleReassign(agent, v, tlOptions.find((o) => o.value === v)?.label, 'Team Leader')}
                                            renderOption={renderTlOption}
                                            size="xs"
                                            w={190}
                                            aria-label={`Reassign ${agent.name} to a different Team Leader`}
                                          />
                                        )}
                                      </Group>
                                    ))}
                                  </Stack>
                                </Box>
                              </Accordion.Panel>
                            </Accordion.Item>
                          );
                        })}
                      </Accordion>
                    )}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            );
          })}
        </Accordion>
      )}

      {unassignedTLs.length > 0 && (
        <Paper withBorder p="md" radius="md">
          <Group mb="sm" gap="xs">
            <Text fw={600} size="sm">Unassigned Team Leaders</Text>
            <Badge variant="light" color="orange" size="sm">{unassignedTLs.length}</Badge>
          </Group>
          <Stack gap="xs">
            {unassignedTLs.map((tl) => (
              <Group key={tl._id} justify="space-between" wrap="nowrap">
                <PersonLabel person={tl} navigate={navigate} />
                {canEdit && (
                  <Select
                    data={thOptions}
                    placeholder="Assign to Teams Head..."
                    onChange={(v) => v && handleReassign(tl, v, thOptions.find((o) => o.value === v)?.label, 'Teams Head')}
                    size="xs"
                    w={200}
                  />
                )}
              </Group>
            ))}
          </Stack>
        </Paper>
      )}

      {unassignedAgents.length > 0 && (
        <Paper withBorder p="md" radius="md">
          <Group mb="sm" gap="xs">
            <Text fw={600} size="sm">Unassigned Agents</Text>
            <Badge variant="light" color="orange" size="sm">{unassignedAgents.length}</Badge>
          </Group>
          <Stack gap="xs">
            {unassignedAgents.map((agent) => (
              <Group key={agent._id} justify="space-between" wrap="nowrap">
                <PersonLabel person={agent} navigate={navigate} size="xs" />
                {canEdit && (
                  <Select
                    data={tlOptions}
                    placeholder="Assign to Team Leader..."
                    onChange={(v) => v && handleReassign(agent, v, tlOptions.find((o) => o.value === v)?.label, 'Team Leader')}
                    renderOption={renderTlOption}
                    size="xs"
                    w={200}
                  />
                )}
              </Group>
            ))}
          </Stack>
        </Paper>
      )}

      <Modal opened={!!pending} onClose={() => setPending(null)} title={pending ? `Reassign ${pending.person.name}?` : ''} size="sm" centered>
        {pending && (
          <Stack gap="md">
            <Text size="sm">
              Move {pending.person.name} to report to {pending.newManagerName} as their {pending.levelLabel}? Everyone below them moves with them.
            </Text>
            <TextInput
              type="date"
              label="Assignment Date"
              description="The date this move actually took effect - their DSR/Pipeline/Order records from this date onward move to the new team; everything before stays with the old one"
              max={today()}
              required
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.currentTarget.value)}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setPending(null)}>Cancel</Button>
              <Button color="blue" loading={submitting} disabled={!effectiveDate} onClick={confirmReassign}>Yes, reassign</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
