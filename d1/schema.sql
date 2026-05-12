-- Cloudflare D1 schema for SHSID Social Platform

create table if not exists users (
  id text primary key,
  email text not null unique,
  password_hash text,
  role text not null default 'student' check (role in ('student', 'admin')),
  status text not null default 'pending_verification' check (status in ('verified', 'pending_verification', 'rejected', 'banned')),
  english_name text,
  chinese_name text,
  grade integer check (grade >= 1 and grade <= 12),
  class_no integer check (class_no >= 1 and class_no <= 13),
  bio text default '',
  profile_photo text default '',
  verification_video text default '',
  created_at text not null,
  updated_at text not null
);

create table if not exists email_verifications (
  id text primary key,
  user_id text not null references users(id),
  code_hash text not null,
  expires_at text not null,
  attempts integer not null default 0,
  created_at text not null
);

create table if not exists posts (
  id text primary key,
  author_id text not null references users(id),
  title text not null default '',
  category text not null default 'school',
  text text not null default '',
  media text not null default '[]',
  likes text not null default '[]',
  hearts text not null default '[]',
  saved_by text not null default '[]',
  anonymous integer not null default 0,
  sticky integer not null default 0,
  deleted_at text,
  created_at text not null
);

create table if not exists comments (
  id text primary key,
  post_id text not null references posts(id),
  author_id text not null references users(id),
  text text not null,
  reply_to text references comments(id),
  anonymous integer not null default 0,
  deleted_at text,
  created_at text not null
);

create table if not exists follows (
  follower_id text not null references users(id),
  following_id text not null references users(id),
  created_at text not null,
  primary key (follower_id, following_id)
);

create table if not exists stories (
  id text primary key,
  author_id text not null references users(id),
  text text not null,
  views text not null default '[]',
  expires_at text not null,
  archived_at text,
  created_at text not null
);

create table if not exists reels (
  id text primary key,
  author_id text not null references users(id),
  title text not null,
  category text not null default 'school',
  video_url text not null default '',
  likes text not null default '[]',
  created_at text not null
);

create table if not exists reel_comments (
  id text primary key,
  reel_id text not null references reels(id),
  author_id text not null references users(id),
  text text not null,
  anonymous integer not null default 0,
  deleted_at text,
  created_at text not null
);

create table if not exists conversations (
  id text primary key,
  title text not null default '',
  is_group integer not null default 0,
  members text not null default '[]',
  created_at text not null
);

create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations(id),
  author_id text not null references users(id),
  text text not null,
  anonymous integer not null default 0,
  deleted_at text,
  created_at text not null
);

create table if not exists notifications (
  id text primary key,
  user_id text not null references users(id),
  type text not null default 'notice',
  body text not null default '',
  read_at text,
  created_at text not null
);

create table if not exists reports (
  id text primary key,
  reporter_id text not null references users(id),
  target_type text not null default '',
  target_id text not null default '',
  reason text not null default '',
  status text not null default 'pending',
  admin_notes text not null default '',
  resolved_at text,
  created_at text not null
);

create table if not exists audit_logs (
  id text primary key,
  actor_id text,
  action text not null,
  metadata text not null default '{}',
  ip_address text,
  created_at text not null
);

create table if not exists qna (
  id text primary key,
  profile_id text not null references users(id),
  asker_id text,
  question text not null,
  answer text not null default '',
  anonymous integer not null default 0,
  visibility text not null default 'public',
  created_at text not null
);

create table if not exists suggestions (
  id text primary key,
  user_id text not null references users(id),
  text text not null,
  status text not null default 'pending',
  created_at text not null
);

create table if not exists ads (
  id text primary key,
  slot text not null,
  title text not null,
  body text not null default '',
  url text not null default '',
  active integer not null default 1,
  created_at text not null
);

create index if not exists idx_users_email on users(email);
create index if not exists idx_users_status on users(status);
create index if not exists idx_posts_author on posts(author_id);
create index if not exists idx_posts_created on posts(created_at desc);
create index if not exists idx_comments_post on comments(post_id);
create index if not exists idx_reel_comments_reel on reel_comments(reel_id);
create index if not exists idx_follows_follower on follows(follower_id);
create index if not exists idx_follows_following on follows(following_id);
create index if not exists idx_notifications_user on notifications(user_id);
create index if not exists idx_reports_status on reports(status);
create index if not exists idx_audit_logs_actor on audit_logs(actor_id);
create index if not exists idx_audit_logs_created on audit_logs(created_at desc);
create index if not exists idx_qna_profile on qna(profile_id);
