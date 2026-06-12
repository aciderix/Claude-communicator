/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import LoginScreen from './components/LoginScreen';
import Dashboard from './components/Dashboard';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('cc_token') || '');
  const [base, setBase] = useState(localStorage.getItem('cc_url') || '');
  const [channel, setChannel] = useState(localStorage.getItem('cc_channel') || 'default');
  const [isMock, setIsMock] = useState(false);

  const handleLogin = (b: string, t: string, c: string, mock: boolean = false) => {
    if (mock) {
      setIsMock(true);
      return;
    }
    setBase(b);
    setToken(t);
    setChannel(c);
  };

  const handleLogout = () => {
    setIsMock(false);
    setToken('');
    // Intentionally keeping URL/Channel in localStorage for convenience, but clearing token
    localStorage.removeItem('cc_token');
  };

  if (!token && !isMock) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <Dashboard 
      base={base}
      token={token}
      defaultChannel={channel}
      isMock={isMock}
      onLogout={handleLogout}
    />
  );
}
