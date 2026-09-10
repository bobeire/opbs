import { useState, useEffect, useCallback, useRef } from 'react';

interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error' | 'update';
  title: string;
  body: string;
}

interface UpdateStatus {
  status: string;
  version?: string;
  message?: string;
}

let nextId = 1;

function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId++;
      setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), toast.kind === 'update' ? 0 : 6000)
      );
    },
    [dismiss]
  );

  useEffect(() => {
    const offActivity = window.electronAPI.onActivity((ev: any) => {
      show({
        kind: ev.kind === 'success' ? 'success' : 'error',
        title: ev.title,
        body: ev.body
      });
    });
    const offUpdate = window.electronAPI.onUpdateStatus((status: UpdateStatus) => {
      if (status.status === 'downloaded') {
        show({
          kind: 'update',
          title: 'Update ready to install',
          body:
            'OPBS v' +
            (status.version ?? '') +
            ' has been downloaded. Restart to apply, or click here to install now.'
        });
      }
    });
    return () => {
      offActivity();
      offUpdate();
    };
  }, [show]);

  const kit = (kind: Toast['kind']): string => {
    switch (kind) {
      case 'success': return 'toast-success';
      case 'error': return 'toast-error';
      case 'update': return 'toast-update';
      default: return 'toast-info';
    }
  };

  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${kit(t.kind)}`} onClick={() => t.kind === 'update' ? void window.electronAPI.installUpdate() : dismiss(t.id)}>
          <div className="toast-title">{t.title}</div>
          <div className="toast-body">{t.body}</div>
          <button className="toast-close" onClick={(e) => { e.stopPropagation(); dismiss(t.id); }}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default ToastHost;