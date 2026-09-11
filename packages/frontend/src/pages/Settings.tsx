import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Save, RotateCcw } from 'lucide-react';

interface Setting {
  value: any; description: string; updated_at?: string;
}

export default function Settings() {
  const [settings, setSettings] = useState<Record<string, Setting>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const data = await api.get<Record<string, Setting>>('/settings');
      setSettings(data);
      const initial: Record<string, string> = {};
      Object.entries(data).forEach(([key, s]) => { initial[key] = String(s.value); });
      setEdits(initial);
      setHasChanges(false);
    } catch (err) { console.error('Settings load error:', err); } finally { setLoading(false); }
  };

  const handleChange = (key: string, value: string) => {
    setEdits(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates: Record<string, any> = {};
      Object.keys(edits).forEach(key => {
        const numVal = parseFloat(edits[key]);
        updates[key] = isNaN(numVal) ? edits[key] : numVal;
      });
      const data = await api.put<Record<string, Setting>>('/settings', updates);
      setSettings(data);
      setHasChanges(false);
    } catch (err: any) { alert(err.response?.data?.message || 'Failed to save'); } finally { setSaving(false); }
  };

  const handleReset = () => {
    const initial: Record<string, string> = {};
    Object.entries(settings).forEach(([key, s]) => { initial[key] = String(s.value); });
    setEdits(initial);
    setHasChanges(false);
  };

  const settingGroups = [
    {
      title: 'Balance Thresholds',
      keys: ['low_balance_threshold', 'critical_balance_threshold'],
      descriptions: { low_balance_threshold: 'Trigger warning when account balance falls below this amount', critical_balance_threshold: 'Trigger critical alert when balance falls below this' }
    },
    {
      title: 'Transaction Alerts',
      keys: ['large_transaction_threshold'],
      descriptions: { large_transaction_threshold: 'Alert when a single transaction exceeds this amount' }
    },
    {
      title: 'Operational Settings',
      keys: ['pending_transfer_alert_hours', 'reconciliation_period_days'],
      descriptions: { pending_transfer_alert_hours: 'Hours before flagging a pending transfer for attention', reconciliation_period_days: 'Recommended days between account reconciliations' }
    }
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">System Settings</h2>
          <p className="text-sm text-gray-600">Configure thresholds and operational parameters</p>
        </div>
        <div className="flex gap-2">
          {hasChanges && (
            <button onClick={handleReset} className="btn-secondary flex items-center gap-2">
              <RotateCcw className="w-4 h-4" /> Reset
            </button>
          )}
          <button onClick={handleSave} disabled={!hasChanges || saving} className="btn-primary flex items-center gap-2 disabled:opacity-50">
            <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="text-center py-12 text-gray-500">Loading settings...</div></div>
      ) : (
        <div className="space-y-6">
          {settingGroups.map(group => (
            <div key={group.title} className="card">
              <h3 className="font-semibold text-gray-900 mb-4">{group.title}</h3>
              <div className="space-y-4">
                {group.keys.map(key => {
                  const setting = settings[key];
                  const currentVal = edits[key] ?? '';
                  return (
                    <div key={key} className="flex items-center justify-between gap-4">
                      <div className="flex-1">
                        <label className="text-sm font-medium text-gray-700">{key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</label>
                        {setting?.description && <p className="text-xs text-gray-500 mt-0.5">{group.descriptions[key as keyof typeof group.descriptions] || setting.description}</p>}
                      </div>
                      <div className="w-48">
                        <input type="number" step="0.01" value={currentVal} onChange={e => handleChange(key, e.target.value)}
                          className={`input-field text-right ${edits[key] !== String(settings[key]?.value) ? 'border-yellow-400 bg-yellow-50' : ''}`} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="card">
            <h3 className="font-semibold text-gray-900 mb-4">System Information</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><p className="text-gray-500">Version</p><p className="font-medium">1.0.0</p></div>
              <div><p className="text-gray-500">Environment</p><p className="font-medium capitalize">Development</p></div>
              <div><p className="text-gray-500">Database</p><p className="font-medium">PostgreSQL</p></div>
              <div><p className="text-gray-500">Currency</p><p className="font-medium">PHP (₱)</p></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
