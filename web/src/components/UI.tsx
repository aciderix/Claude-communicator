import React from 'react';
import { motion } from 'motion/react';
import { Loader2 } from 'lucide-react';

export function Card({ className = '', children, ...props }: React.ComponentProps<typeof motion.div>) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`bg-slate-900/60 border border-white/5 rounded-2xl p-5 shadow-sm overflow-hidden ${className}`}
      {...props as any}
    >
      {children}
    </motion.div>
  );
}

export function Badge({ 
  children, 
  variant = 'default',
  className = '' 
}: { 
  children: React.ReactNode; 
  variant?: 'default' | 'ok' | 'warn' | 'bad' | 'purple' | 'idle';
  className?: string;
}) {
  const dotColor = {
    default: 'bg-slate-500',
    ok: 'bg-emerald-500',
    warn: 'bg-amber-400',
    bad: 'bg-rose-500',
    purple: 'bg-purple-400',
    idle: 'bg-slate-600'
  };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800/40 border border-white/[0.03] text-[11px] font-medium text-slate-300 whitespace-nowrap ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor[variant]}`}></span>
      {children}
    </span>
  );
}

export function Button({ 
  variant = 'secondary', 
  loading = false,
  className = '', 
  children, 
  ...props 
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { 
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
}) {
  const baseStyle = "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50 disabled:cursor-not-allowed";
  
  const variants = {
    primary: "bg-blue-600/90 hover:bg-blue-500 text-white shadow-sm border border-blue-500 px-4 py-2 text-sm",
    secondary: "bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-white/5 px-4 py-2 text-sm",
    ghost: "bg-transparent hover:bg-slate-800/60 text-slate-300 px-3 py-1.5 text-sm",
    danger: "bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 px-4 py-2 text-sm",
  };

  return (
    <button className={`${baseStyle} ${variants[variant]} ${className}`} disabled={loading || props.disabled} {...props}>
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input 
      className={`bg-slate-950/50 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 focus:bg-slate-900 transition-colors ${className}`}
      {...props}
    />
  );
}

export function TextArea({ className = '', ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea 
      className={`bg-slate-950/50 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 focus:bg-slate-900 transition-colors resize-y min-h-[80px] ${className}`}
      {...props}
    />
  );
}
