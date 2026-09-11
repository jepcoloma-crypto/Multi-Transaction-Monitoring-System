import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Trash2, RefreshCw, Database, Upload } from 'lucide-react';

interface BackupFile {
  filename: string;
  size: number;
  createdAt: string;
}

export default function Backup() {
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const fetchBackups = async () => {
    setLoading(true);
    try {
      const result = await api.get<BackupFile[]>('/backup');
      setBackups(result);
    } catch (err) { console.error('Backup load error:', err); } finally { setLoading(false); }
  };

  useEffect(() => { fetchBackups(); }, []);

  const handleCreate = async () => {
    if (!confirm('Create a database backup now?')) return;
    setCreating(true);
    try {
      await api.post('/backup/create', {});
      fetchBackups();
    } catch (err: any) { alert(err.message); } finally { setCreating(false); }
  };

  const handleRestore = async (filename: string) => {
    if (!confirm(`Restore database from ${filename}? This will overwrite current data!`)) return;
    setRestoring(filename);
    try {
      await api.post('/backup/restore', { filename });
      alert('Database restored successfully!');
    } catch (err: any) { alert(err.message); } finally { setRestoring(null); }
  };

  const handleDelete = async (filename: string) => {
    if (!confirm(`Delete ${filename}?`)) return;
    try {
      await api.delete(`/backup/${filename}`);
      fetchBackups();
    } catch (err: any) { alert(err.message); }
  };

  const handleDownload = async (filename: string) => {
    try {
      const token = localStorage.getItem('accessToken');
      const response = await fetch(`/api/backup/download/${filename}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('Download failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) { alert(err.message); }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Database Backup</h2>
          <p className="text-sm text-gray-500">Create, restore, and manage database backups</p>
        </div>
        <button onClick={handleCreate} disabled={creating} className="btn-primary flex items-center gap-2">
          <Database className={`w-4 h-4 ${creating ? 'animate-spin' : ''}`} />
          {creating ? 'Creating...' : 'Create Backup'}
        </button>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">Backup Files</h3>
          <button onClick={fetchBackups} className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        {loading ? (
          <div className="text-center py-8 text-gray-500">Loading...</div>
        ) : backups.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Database className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>No backups yet</p>
            <p className="text-xs mt-1">Click "Create Backup" to make your first backup</p>
          </div>
        ) : (
          <div className="space-y-2">
            {backups.map((backup) => (
              <div key={backup.filename} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div>
                  <p className="text-sm font-medium">{backup.filename}</p>
                  <p className="text-xs text-gray-500">
                    {formatSize(backup.size)} | {new Date(backup.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleDownload(backup.filename)}
                    className="text-gray-400 hover:text-primary-600" title="Download">
                    ⬇
                  </button>
                  <button onClick={() => handleRestore(backup.filename)} disabled={restoring === backup.filename}
                    className="text-gray-400 hover:text-green-600 disabled:opacity-50" title="Restore">
                    <Upload className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(backup.filename)}
                    className="text-gray-400 hover:text-red-600" title="Delete">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card bg-yellow-50 border-yellow-200">
        <h3 className="text-sm font-semibold text-yellow-800 mb-2">Important Notes</h3>
        <ul className="text-xs text-yellow-700 space-y-1">
          <li>• Backups are stored locally in the server's backup directory</li>
          <li>• Regular backups are recommended before major changes</li>
          <li>• Restoring a backup will overwrite the current database</li>
          <li>• Download backups to keep off-site copies</li>
        </ul>
      </div>
    </div>
  );
}
