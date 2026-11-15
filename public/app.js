// XLR8 client shell. All user-provided text is rendered with textContent.
const main = document.getElementById('main');
const nav = document.getElementById('nav');
const banner = document.getElementById('engine');
let me = { user: null, organizations: [] };

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'text') node.textContent = value;
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message ?? `Request failed (${response.status})`);
  return data;
}

function when(iso, zone) {
  const date = new Date(iso);
  const local = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  const event = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: zone, timeZoneName: 'short' }).format(date);
  return `${local} (your time) · ${event}`;
}

function form(fields, submitLabel, onSubmit) {
  const error = h('p', { class: 'error', role: 'alert' });
  const node = h('form', { onsubmit: async event => {
    event.preventDefault();
    error.textContent = '';
    const values = Object.fromEntries(new FormData(node));
    try { await onSubmit(values); } catch (e) { error.textContent = e.message; }
  } }, fields.map(([name, label, type = 'text', extra = {}]) => h('label', {}, label, type === 'select'
    ? h('select', { name }, extra.options.map(([v, t]) => h('option', { value: v, text: t })))
    : h('input', { name, type, required: extra.optional ? undefined : true, value: extra.value, autocomplete: extra.autocomplete }))), h('button', { type: 'submit', text: submitLabel }), error);
  return node;
}

function go(path) { history.pushState({}, '', path); route(); }
document.addEventListener('click', event => {
  const link = event.target.closest('a[data-link]');
  if (link) { event.preventDefault(); go(link.getAttribute('href')); }
});
window.addEventListener('popstate', route);

function renderNav() {
  nav.replaceChildren(...(me.user
    ? [h('span', { class: 'muted', text: `${me.user.displayName}${me.user.kind === 'guest' ? ' (guest)' : ''}` }), h('button', { class: 'secondary', text: 'Sign out', onclick: async () => { await api('/auth/logout', { method: 'POST' }); await refresh(); go('/'); } })]
    : [h('a', { href: '/', 'data-link': true, text: 'Sign in' })]));
}

async function refresh() { me = await api('/me').catch(() => ({ user: null, organizations: [] })); renderNav(); }

async function home() {
  const { events } = await api('/events');
  const list = h('div', {}, events.length ? events.map(e => h('div', { class: 'card' }, h('a', { href: `/events/${e.slug}`, 'data-link': true, text: e.title }), e.status === 'cancelled' ? h('span', { class: 'pill', text: 'cancelled' }) : null, h('div', { class: 'muted', text: `${e.organization?.name ?? ''} · ${when(e.startsAt, e.timezone)}` }))) : h('p', { class: 'muted', text: 'No public events yet.' }));
  const nodes = [h('h1', { text: 'Events' }), list];
  if (!me.user) {
    nodes.push(h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('h2', { text: 'Sign in' }), form([['email', 'Email', 'email', { autocomplete: 'email' }], ['password', 'Password', 'password', { autocomplete: 'current-password' }]], 'Sign in', async v => { await api('/auth/login', { method: 'POST', body: v }); await refresh(); route(); })),
      h('div', { class: 'card' }, h('h2', { text: 'Create an organizer account' }), form([['displayName', 'Name'], ['email', 'Email', 'email', { autocomplete: 'email' }], ['password', 'Password (10+ characters)', 'password', { autocomplete: 'new-password' }]], 'Create account', async v => { await api('/auth/signup', { method: 'POST', body: v }); await refresh(); route(); }))));
  } else if (me.user.kind === 'account') {
    nodes.push(h('h2', { text: 'Your organizations' }), ...me.organizations.map(o => h('div', { class: 'card' }, h('a', { href: `/org/${o.slug}`, 'data-link': true, text: o.name }), h('span', { class: 'pill', text: o.role }))),
      h('div', { class: 'card' }, h('h3', { text: 'New organization' }), form([['name', 'Name'], ['slug', 'Short name (lowercase, dashes)']], 'Create', async v => { const org = await api('/orgs', { method: 'POST', body: v }); await refresh(); go(`/org/${org.slug}`); })));
  }
  main.replaceChildren(...nodes);
}

async function organization(slug) {
  const { events } = await api(`/orgs/${slug}/events`);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  main.replaceChildren(h('h1', { text: me.organizations.find(o => o.slug === slug)?.name ?? slug }),
    ...events.map(e => h('div', { class: 'card' }, h('a', { href: `/events/${e.slug}`, 'data-link': true, text: e.title }), h('span', { class: 'pill', text: e.status }), h('span', { class: 'pill', text: e.visibility }), h('div', { class: 'muted', text: when(e.startsAt, e.timezone) }))),
    h('div', { class: 'card' }, h('h2', { text: 'New event' }), form([['title', 'Title'], ['slug', 'Link name (lowercase, dashes)'], ['timezone', 'Time zone (IANA)', 'text', { value: zone }], ['startsAt', 'Starts (local)', 'datetime-local'], ['endsAt', 'Ends (local)', 'datetime-local'], ['visibility', 'Visibility', 'select', { options: [['public', 'Public'], ['private', 'Private (invitation only)']] }], ['capacity', 'Capacity', 'number', { value: '100' }]], 'Create draft', async v => {
      const event = await api(`/orgs/${slug}/events`, { method: 'POST', body: { ...v, capacity: Number(v.capacity), startsAt: new Date(v.startsAt).toISOString(), endsAt: new Date(v.endsAt).toISOString() } });
      go(`/events/${event.slug}`);
    })),
    h('div', { class: 'card' }, h('h3', { text: 'Add a team member' }), form([['email', 'Their account email', 'email'], ['role', 'Role', 'select', { options: [['organizer', 'Organizer'], ['member', 'Member']] }]], 'Add', async v => { await api(`/orgs/${slug}/members`, { method: 'POST', body: v }); alert('Member added'); })));
}

async function eventPage(slug) {
  const e = await api(`/events/by-slug/${slug}`);
  const reload = () => eventPage(slug);
  const nodes = [h('h1', {}, e.title, h('span', { class: 'pill', text: e.status }), h('span', { class: 'pill', text: e.visibility })), h('p', { class: 'muted', text: `${e.organization.name} · ${when(e.startsAt, e.timezone)} → ${when(e.endsAt, e.timezone)}` }), h('p', { text: e.description })];
  nodes.push(h('p', { class: 'muted', text: `Seats: ${e.seats.registered}/${e.seats.capacity} registered${e.seats.waitlisted !== undefined ? ` · ${e.seats.waitlisted} waitlisted` : ''}` }));
  if (me.user && e.status === 'published') {
    nodes.push(e.registration && e.registration.status !== 'cancelled'
      ? h('div', { class: 'card' }, h('strong', { text: e.registration.status === 'registered' ? 'You are registered.' : 'You are on the waitlist.' }), ' ', h('button', { class: 'secondary', text: 'Cancel registration', onclick: async () => { await api(`/events/${e.id}/registration`, { method: 'DELETE' }); reload(); } }))
      : h('button', { text: 'Register', onclick: async () => { await api(`/events/${e.id}/registration`, { method: 'POST' }); reload(); } }));
  } else if (!me.user && e.status === 'published') nodes.push(h('p', { class: 'muted', text: 'Sign in to register.' }));
  nodes.push(h('h2', { text: 'Agenda' }), ...e.sessions.map(s => h('div', { class: 'card' }, h('strong', { text: s.title }), h('span', { class: 'pill', text: s.kind }), s.status !== 'published' ? h('span', { class: 'pill', text: s.status }) : null,
    h('div', { class: 'muted', text: when(s.startsAt, e.timezone) }),
    h('button', { class: 'secondary', text: 'Enter 3D room', onclick: async event => { try { await api(`/events/${e.id}/sessions/${s.id}/join`, { method: 'POST' }); } catch (err) { event.target.replaceWith(h('p', { class: 'muted', text: err.message })); } } }))));
  if (!e.sessions.length) nodes.push(h('p', { class: 'muted', text: 'No sessions published yet.' }));
  if (e.organizer) {
    const tools = h('div', { class: 'card' }, h('h2', { text: 'Organizer tools' }));
    if (e.status === 'draft') tools.append(h('button', { text: 'Publish event', onclick: async () => { await api(`/events/${e.id}/publish`, { method: 'POST' }); reload(); } }));
    if (e.status !== 'cancelled') tools.append(' ', h('button', { class: 'secondary', text: 'Cancel event', onclick: async () => { if (confirm('Cancel this event? The link stays valid and shows it as cancelled.')) { await api(`/events/${e.id}/cancel`, { method: 'POST' }); reload(); } } }));
    tools.append(h('h3', { text: 'Add session' }), form([['title', 'Title'], ['kind', 'Type', 'select', { options: [['talk', 'Talk'], ['keynote', 'Keynote'], ['workshop', 'Workshop'], ['breakout', 'Breakout'], ['social', 'Social'], ['exhibition', 'Exhibition']] }], ['startsAt', 'Starts (local)', 'datetime-local'], ['endsAt', 'Ends (local)', 'datetime-local']], 'Add and publish', async v => {
      await api(`/events/${e.id}/sessions`, { method: 'POST', body: { ...v, publish: true, startsAt: new Date(v.startsAt).toISOString(), endsAt: new Date(v.endsAt).toISOString() } }); reload();
    }));
    const out = h('p');
    tools.append(h('h3', { text: 'Invitation link' }), form([['email', 'Restrict to email (optional)', 'email', { optional: true }], ['maxUses', 'Uses', 'number', { value: '1' }]], 'Create link', async v => {
      const inv = await api(`/events/${e.id}/invitations`, { method: 'POST', body: { maxUses: Number(v.maxUses), ...(v.email ? { email: v.email } : {}) } });
      out.replaceChildren('Share: ', h('code', { text: `${location.origin}${inv.path}` }), h('span', { class: 'muted', text: ` (expires ${new Date(inv.expiresAt).toLocaleString()})` }));
    }), out);
    const { attendees } = await api(`/events/${e.id}/attendees`);
    tools.append(h('h3', { text: 'Attendees' }), h('table', {}, h('tr', {}, h('th', { text: 'Name' }), h('th', { text: 'Status' }), h('th', { text: 'Check-in' })), attendees.map(a => h('tr', {}, h('td', { text: `${a.displayName}${a.kind === 'guest' ? ' (guest)' : ''}` }), h('td', { text: a.status }), h('td', {}, a.checkedInAt ? new Date(a.checkedInAt).toLocaleTimeString() : a.status === 'registered' ? h('button', { class: 'secondary', text: 'Check in', onclick: async () => { await api(`/events/${e.id}/attendees/${a.id}/check-in`, { method: 'POST' }); reload(); } }) : '')))));
    nodes.push(tools);
  }
  main.replaceChildren(...nodes);
}

async function invite(token) {
  const preview = await api(`/invitations/${token}`);
  const accept = async body => { const r = await api(`/invitations/${token}/accept`, { method: 'POST', body }); await refresh(); main.replaceChildren(h('h1', { text: 'You are in' }), h('p', { text: r.registration.status === 'registered' ? 'Your seat is confirmed.' : 'The event is full; you are on the waitlist.' }), h('a', { href: `/events/${preview.event.slug}`, 'data-link': true, text: 'Open the event' })); };
  main.replaceChildren(h('h1', { text: `Invitation: ${preview.event.title}` }), h('p', { class: 'muted', text: when(preview.event.startsAt, preview.event.timezone) }),
    me.user ? h('button', { text: `Accept as ${me.user.displayName}`, onclick: () => accept({}).catch(e => alert(e.message)) })
      : preview.requiresEmail ? h('p', { text: 'This invitation is for a specific email address. Sign in with that account on the home page, then reopen this link.' })
        : h('div', { class: 'card' }, h('p', { text: 'Join as a guest (no account needed):' }), form([['displayName', 'Your name']], 'Accept invitation', accept)));
}

async function route() {
  const path = location.pathname;
  try {
    let m;
    if ((m = path.match(/^\/events\/([a-z0-9-]+)$/))) await eventPage(m[1]);
    else if ((m = path.match(/^\/org\/([a-z0-9-]+)$/))) await organization(m[1]);
    else if ((m = path.match(/^\/invite\/([A-Za-z0-9_-]+)$/))) await invite(m[1]);
    else await home();
  } catch (error) {
    main.replaceChildren(h('h1', { text: 'Not available' }), h('p', { class: 'error', text: error.message }), h('a', { href: '/', 'data-link': true, text: 'Back to events' }));
  }
  main.focus();
}

const config = await fetch('/config.json').then(r => r.json()).catch(() => null);
if (config?.engine?.state !== 'configured') { banner.hidden = false; banner.textContent = `3D venue unavailable: ${config?.engine?.reason ?? 'engine status unknown.'}`; }
await refresh();
await route();
