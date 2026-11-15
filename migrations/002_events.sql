-- C03: events, sessions and schedule persistence.
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
  timezone text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled')),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100000),
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX events_org ON events (organization_id);

CREATE TABLE event_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK (kind IN ('keynote', 'talk', 'workshop', 'breakout', 'social', 'exhibition')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled')),
  world_template text CHECK (world_template IS NULL OR world_template ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX event_sessions_event ON event_sessions (event_id, starts_at);
