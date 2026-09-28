// Ported from FenixAgent/web/components/chat/session-grouping.ts.
export function groupByRecency(sessions, labels) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const groups = [
    { label: labels.today, sessions: [] },
    { label: labels.yesterday, sessions: [] },
    { label: labels.earlier, sessions: [] },
  ];
  const sorted = [...sessions].sort((a, b) => {
    const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return dateB - dateA;
  });
  for (const session of sorted) {
    const date = session.updatedAt ? new Date(session.updatedAt) : new Date(0);
    if (date >= today) groups[0].sessions.push(session);
    else if (date >= yesterday) groups[1].sessions.push(session);
    else groups[2].sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length > 0);
}
