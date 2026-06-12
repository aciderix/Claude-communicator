export class ApiClient {
  private base: string;
  private token: string;

  constructor(base: string, token: string) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
  }

  async rawFetch(path: string, opts: RequestInit = {}, timeoutMs = 35000): Promise<any> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        // contourne la page interstitielle des tunnels type loca.lt
        'bypass-tunnel-reminder': '1',
      };
      if (this.token) {
        headers['authorization'] = `Bearer ${this.token}`;
      }

      const r = await fetch(`${this.base}${path}`, {
        ...opts,
        signal: ctl.signal,
        headers: {
          ...headers,
          ...opts.headers,
        },
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  async getChannels(): Promise<string[]> {
    const res = await this.rawFetch('/channels');
    return res.channels || [];
  }

  async pairCode(code: string): Promise<string> {
    const res = await this.rawFetch('/pair', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    return res.token;
  }

  async getState(channel: string, version: number): Promise<any> {
    return this.rawFetch(`/c/${encodeURIComponent(channel)}/state?version=${version}&wait=25`);
  }

  async postMsg(channel: string, to: string, body: string): Promise<any> {
    return this.rawFetch(`/c/${encodeURIComponent(channel)}/user-post`, {
      method: 'POST',
      body: JSON.stringify({ to, body }),
    });
  }

  async answerQuestion(channel: string, id: string, answer: string): Promise<any> {
    return this.rawFetch(`/c/${encodeURIComponent(channel)}/user-answer`, {
      method: 'POST',
      body: JSON.stringify({ id, answer }),
    });
  }

  async setStandup(channel: string, minutes: number): Promise<any> {
    return this.rawFetch(`/c/${encodeURIComponent(channel)}/config`, {
      method: 'POST',
      body: JSON.stringify({ standup_minutes: minutes }),
    });
  }

  async requestDiff(channel: string, peer: string, mode: string = 'stat', timeoutMs = 45000): Promise<{ ok: boolean, result?: string, error?: string }> {
    try {
      const data = await this.rawFetch(`/c/${encodeURIComponent(channel)}/service/${encodeURIComponent(peer)}`, {
        method: 'POST',
        body: JSON.stringify({ from: 'user', action: 'diff', params: { mode } }),
      }, timeoutMs);
      return data;
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
}
