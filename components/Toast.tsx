import React, { createContext, use, useEffect } from 'react';
import { notifyError, notifyInfo, notifySuccess, notifyToast } from '@/utils/notify';

type ToastType = 'success' | 'info' | 'warning' | 'error';

interface ToastOptions {
  type?: ToastType;
  duration?: number;
}

interface ToastAPI {
  show: (message: string, options?: ToastOptions) => void;
  success: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastAPI | null>(null);

export function useToast(): ToastAPI {
  const ctx = use(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const show = (message: string, options?: ToastOptions) => {
    if (!message) return;
    void notifyToast(options?.type ?? 'success', message, options?.duration ?? 3000);
  };

  const api: ToastAPI = {
    show,
    success: (message: string, duration?: number) => {
      void notifySuccess(message, duration);
    },
    info: (message: string, duration?: number) => {
      void notifyInfo(message, duration);
    },
    error: (message: string, duration?: number) => {
      void notifyError(message, duration);
    },
  };

  useEffect(() => {
    window.toast = api;
    return () => {
      if (window.toast === api) {
        window.toast = undefined;
      }
    };
  }, [api]);

  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
};
