-- Production-oriented PostgreSQL schema outline for SHSID Social Platform.
-- The prototype uses localStorage; production should use these tables or an equivalent ORM model.

create table users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('student', 'admin')),
  status text not null check (status in ('verified', 'pending_verification', 'rejected', 'banned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table profiles (
  user_id uuid primary key references users(id) on delete cascade,
  english_name text not null,
  chinese_name text not null,
  grade int not null check (grade between 1 and 12),
  class_no int not null check (class_no between 1 and 13),
  bio text,
  avatar_url text,
  unique (english_name, chinese_name)
);

create table verification_submissions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  video_url text not null,
  status text not null check (status in ('pending', 'approved', 'rejected')),
  reviewer_id uuid references users(id),
  decision_notes text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table posts (
  id uuid primary key,
  author_id uuid not null references users(id) on delete cascade,
  category text not null,
  body text,
  anonymous boolean not null default false,
  sticky boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table post_media (
  id uuid primary key,
  post_id uuid not null references posts(id) on delete cascade,
  media_type text not null check (media_type in ('image', 'video')),
  url text not null,
  sort_order int not null default 0
);

create table comments (
  id uuid primary key,
  post_id uuid not null references posts(id) on delete cascade,
  author_id uuid not null references users(id) on delete cascade,
  body text not null,
  anonymous boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table likes (
  user_id uuid not null references users(id) on delete cascade,
  target_type text not null check (target_type in ('post', 'comment', 'reel')),
  target_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, target_type, target_id)
);

create table follows (
  follower_id uuid not null references users(id) on delete cascade,
  following_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id)
);

create table stories (
  id uuid primary key,
  author_id uuid not null references users(id) on delete cascade,
  body text,
  media_url text,
  archived_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table story_views (
  story_id uuid not null references stories(id) on delete cascade,
  viewer_id uuid not null references users(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);

create table reels (
  id uuid primary key,
  author_id uuid not null references users(id) on delete cascade,
  title text not null,
  video_url text not null,
  category text not null,
  created_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key,
  title text,
  is_group boolean not null default false,
  created_at timestamptz not null default now()
);

create table conversation_members (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member',
  primary key (conversation_id, user_id)
);

create table messages (
  id uuid primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  author_id uuid not null references users(id) on delete cascade,
  body text not null,
  anonymous boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table reports (
  id uuid primary key,
  reporter_id uuid not null references users(id) on delete cascade,
  target_type text not null,
  target_id uuid not null,
  reason text not null,
  status text not null check (status in ('pending', 'reviewed', 'resolved')),
  admin_notes text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table bans (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  admin_id uuid not null references users(id),
  reason text not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz
);

create table notifications (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  type text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table audit_logs (
  id uuid primary key,
  actor_id uuid references users(id),
  action text not null,
  target_type text,
  target_id uuid,
  ip_address inet,
  user_agent text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table qna_questions (
  id uuid primary key,
  profile_user_id uuid not null references users(id) on delete cascade,
  asker_id uuid references users(id) on delete set null,
  question text not null,
  answer text,
  anonymous boolean not null default false,
  visibility text not null check (visibility in ('public', 'private')),
  created_at timestamptz not null default now()
);

create table suggestions (
  id uuid primary key,
  author_id uuid references users(id) on delete set null,
  body text not null,
  anonymous boolean not null default true,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);
