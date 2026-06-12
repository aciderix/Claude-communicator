export interface Session {
  live: boolean;
  name: string;
  role?: string;
  state?: string;
  last_model_seen?: string;
  compacting?: boolean;
  compacted_at?: string;
  host?: string;
  branch?: string;
  head?: string;
  last_seen?: string;
  task?: string;
  progress?: string;
  detail?: string;
}

export interface Milestone {
  id: string;
  title: string;
  status: string; // 'todo' | 'active' | 'done' | 'dropped'
  detail?: string;
}

export interface Task {
  id: string;
  status: string; // 'todo' | 'in_progress' | 'done' | 'blocked'
  milestone?: string;
  title: string;
  owner?: string;
  deps?: string[];
  notes?: string[];
}

export interface Plan {
  goal?: string;
  milestones?: Milestone[];
}

export interface Reply {
  by: string;
  ts: string;
  body: string;
}

export interface Msg {
  id: string;
  to: string;
  ts: string;
  status?: string;
  claimed_by?: string;
  body: string;
  replies?: Reply[];
}

export interface Question {
  id: string;
  status: string; // 'open' | 'answered'
  from: string;
  ts: string;
  text: string;
  context?: string;
  options?: string[];
  answered_at?: string;
  answer?: string;
}

export interface Review {
  id: string;
  status: string; // 'pending' | 'approved' | 'changes_requested' | 'closed'
  title?: string;
  from: string;
  to: string;
}

export interface Lock {
  path: string;
  owner: string;
  reason?: string;
}

export interface Note {
  by: string;
  text: string;
}

export interface AppState {
  version: number;
  sessions: Session[];
  plan: Plan;
  tasks: { tasks: Task[] };
  user?: { msgs: { items: Msg[] }; questions: { items: Question[] } };
  reviews: { items: Review[] };
  locks: Lock[];
  notes_tail: Note[];
  config?: { standup_minutes: number };
}
