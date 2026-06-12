import { useState } from 'react';
import LoginScreen from './components/LoginScreen';
import Dashboard from './components/Dashboard';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('cc_token') || '');
  const [base, setBase] = useState(localStorage.getItem('cc_url') || '');
  const [channel, setChannel] = useState(localStorage.getItem('cc_channel') || 'default');

  const handleLogin = (b: string, t: string, c: string) => {
    setBase(b);
    setToken(t);
    setChannel(c);
  };

  const handleLogout = () => {
    setToken('');
    // URL et canal conservés pour la prochaine connexion ; jeton effacé
    localStorage.removeItem('cc_token');
  };

  if (!token) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <Dashboard
      base={base}
      token={token}
      defaultChannel={channel}
      onLogout={handleLogout}
    />
  );
}
