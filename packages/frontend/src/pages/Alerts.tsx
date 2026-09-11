import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Bell, CheckCheck, Eye } from 'lucide-react';

interface Alert {
  id: string; alert_type: string; severity: string; entity: string;
  title: string; message: string; is_read: boolean; created_at: string; data: any;
}

export default function Alerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  const loadData = async () => {
    try {
      const res = await api.get<{ data: Alert[]; unreadCount: number }>(`/alerts${filter === 'unread' ? '?isRead=false' : ''}`);
      setAlerts(res.data);
      setUnreadCount(res.unreadCount);
    } catch (err) { console.error('Alerts load error:', err); } finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, [filter]);

  const markRead = async (id: string) => {
    try { await api.put(`/alerts/${id}/read`, {}); loadData(); } catch (err) { console.error('Alert mark read error:', err); }
  };

  const markAllRead = async () => {
    try { await api.put('/alerts/read-all', {}); loadData(); } catch (err) { console.error('Alerts mark all read error:', err); }
  };

  const severityIcon = (s: string) => {
    if (s === 'critical' || s === 'error') return '🔴';
    if (s === 'warning') return '🟡';
    return '🔵';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Alerts</h2>
          <p className="text-sm text-gray-600">{unreadCount} unread alerts</p>
        </div>
        {unreadCount > 0 && (
          <button onClick={markAllRead} className="btn-secondary flex items-center gap-2">
            <CheckCheck className="w-4 h-4" /> Mark All Read
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <button onClick={() => setFilter('')} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${!filter ? 'bg-primary-100 text-primary-700' : 'text-gray-600 hover:bg-gray-100'}`}>All</button>
        <button onClick={() => setFilter('unread')} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${filter === 'unread' ? 'bg-primary-100 text-primary-700' : 'text-gray-600 hover:bg-gray-100'}`}>Unread</button>
      </div>

      {loading ? (
        <div className="card"><div className="text-center py-12 text-gray-500">Loading...</div></div>
      ) : alerts.length === 0 ? (
        <div className="card"><div className="text-center py-12 text-gray-500">
          <Bell className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="font-medium">No alerts</p>
          <p className="text-sm mt-1">System alerts will appear here</p>
        </div></div>
      ) : (
        <div className="space-y-3">
          {alerts.map(alert => (
            <div key={alert.id} className={`card ${!alert.is_read ? 'border-l-4 border-l-blue-500' : 'opacity-70'}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span>{severityIcon(alert.severity)}</span>
                    <h4 className="font-medium text-gray-900">{alert.title}</h4>
                    <span className="text-xs text-gray-500">{alert.alert_type}</span>
                  </div>
                  {alert.message && <p className="text-sm text-gray-600 mt-1">{alert.message}</p>}
                  <p className="text-xs text-gray-400 mt-2">{new Date(alert.created_at).toLocaleString()}</p>
                </div>
                {!alert.is_read && (
                  <button onClick={() => markRead(alert.id)} className="p-1 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-600" title="Mark as read">
                    <Eye className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
