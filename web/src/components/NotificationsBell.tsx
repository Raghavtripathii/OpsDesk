import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMarkNotificationsRead, useNotifications } from '../api/queries';
import type { AppNotification } from '../api/types';
import { humanize, statusLabel, timeAgo } from '../format';
import type { ItemStatus } from '../api/types';

function text(n: AppNotification): string {
  const who = typeof n.data.actorName === 'string' ? n.data.actorName : 'Someone';
  const ref = typeof n.data.itemRef === 'string' ? n.data.itemRef : 'an item';
  const to = statusLabel[n.data.to as ItemStatus] ?? humanize(String(n.data.to ?? ''));

  switch (n.type) {
    case 'comment':
      return `${who} commented on ${ref}`;
    case 'assigned':
      return `${who} assigned ${ref} to you`;
    case 'unassigned':
      return `${who} took you off ${ref}`;
    case 'approval_requested':
      return `${ref} is waiting for your approval`;
    case 'picked_up':
      return `${who} picked up ${ref}`;
    case 'priority_urgent':
      return `${ref} was marked urgent`;
    case 'status_changed':
      return `${who} moved ${ref} to ${to}`;
    default:
      return `${humanize(n.type)}: ${ref}`;
  }
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { data } = useNotifications();
  const markRead = useMarkNotificationsRead();

  // close when clicking anywhere else
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const unread = data?.unreadCount ?? 0;
  const label = unread >= (data?.unreadCap ?? 100) ? `${unread}+` : String(unread);

  const openNotification = (n: AppNotification) => {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    setOpen(false);
    if (n.itemId !== null) navigate(`/items/${n.itemId}`);
  };

  return (
    <div className="bell" ref={wrapper}>
      <button className="btn btn-ghost" aria-label={`Notifications, ${unread} unread`} onClick={() => setOpen((v) => !v)}>
        Notifications
        {unread > 0 && <span className="count">{label}</span>}
      </button>

      {open && (
        <div className="popover">
          <div className="popover-head">
            <strong>Notifications</strong>
            <button className="link-btn" disabled={unread === 0} onClick={() => markRead.mutate({ all: true })}>
              Mark all read
            </button>
          </div>
          {data?.notifications.length ? (
            <ul className="notif-list">
              {data.notifications.map((n) => (
                <li key={n.id}>
                  <button className={`notif ${n.readAt ? '' : 'unread'}`} onClick={() => openNotification(n)}>
                    <span>{text(n)}</span>
                    {typeof n.data.title === 'string' && <span className="muted small">{n.data.title}</span>}
                    {typeof n.data.excerpt === 'string' && n.data.excerpt && (
                      <span className="muted small">“{n.data.excerpt}”</span>
                    )}
                    <span className="muted small">{timeAgo(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted pad">You are all caught up.</p>
          )}
        </div>
      )}
    </div>
  );
}