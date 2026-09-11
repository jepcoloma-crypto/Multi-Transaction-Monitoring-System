import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { User, Lock, Clock, Shield, Edit, Camera, Trash2 } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface Profile {
  id: string; email: string; first_name: string; last_name: string; is_active: boolean;
  last_login_at: string; created_at: string; roles: string[]; permissions: string[];
  avatar_url: string | null;
  loginHistory: Array<{ created_at: string; ip_address: string }>;
}

export default function Profile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '' });
  const [saving, setSaving] = useState(false);

  const [showPassword, setShowPassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [changingPassword, setChangingPassword] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadProfile(); }, []);

  const loadProfile = async () => {
    try {
      const data = await api.get<Profile>('/profile/profile');
      setProfile(data);
      setForm({ firstName: data.first_name, lastName: data.last_name, email: data.email });
    } catch (err) { console.error('Profile load error:', err); } finally { setLoading(false); }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('avatar', file);
      const res = await fetch(`${API_BASE}/profile/avatar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('accessToken')}` },
        body: formData,
      });
      const data = await res.json();
      if (data.success) {
        setProfile(p => p ? { ...p, avatar_url: data.data.avatarUrl } : p);
        const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
        storedUser.avatarUrl = data.data.avatarUrl;
        localStorage.setItem('user', JSON.stringify(storedUser));
        window.location.reload();
      }
    } catch (err) { alert('Upload failed'); } finally { setUploading(false); }
  };

  const handleDeleteAvatar = async () => {
    if (!confirm('Remove avatar?')) return;
    try {
      await api.delete('/profile/avatar');
      setProfile(p => p ? { ...p, avatar_url: null } : p);
      const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
      storedUser.avatarUrl = null;
      localStorage.setItem('user', JSON.stringify(storedUser));
      window.location.reload();
    } catch (err) { alert('Failed'); }
  };

  const handleSaveProfile = async () => {
    setSaving(true);
    try {
      await api.put('/profile/profile', form);
      setEditing(false);
      loadProfile();
    } catch (err: any) { alert(err.response?.data?.message || 'Failed'); } finally { setSaving(false); }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordForm.newPassword !== passwordForm.confirmPassword) { alert('Passwords do not match'); return; }
    if (passwordForm.newPassword.length < 6) { alert('Password must be at least 6 characters'); return; }
    setChangingPassword(true);
    try {
      await api.put('/profile/password', { currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword });
      setShowPassword(false);
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      alert('Password updated');
    } catch (err: any) { alert(err.response?.data?.message || 'Failed'); } finally { setChangingPassword(false); }
  };

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" /></div>;
  if (!profile) return <div className="card text-center py-12 text-gray-500">Profile not found</div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">My Profile</h2>
        <p className="text-sm text-gray-600">Manage your account settings</p>
      </div>

      <div className="card">
        <h3 className="font-semibold mb-4">Profile Picture</h3>
        <div className="flex items-center gap-6">
          <div className="w-20 h-20 rounded-full bg-primary-100 flex items-center justify-center overflow-hidden">
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt="Avatar" className="w-full h-full object-cover" />
            ) : (
              <span className="text-2xl font-bold text-primary-700">{profile.first_name?.[0]}{profile.last_name?.[0]}</span>
            )}
          </div>
          <div className="flex gap-2">
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} />
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="btn-secondary text-sm flex items-center gap-1">
              <Camera className="w-4 h-4" /> {uploading ? 'Uploading...' : 'Upload Photo'}
            </button>
            {profile.avatar_url && (
              <button onClick={handleDeleteAvatar} className="btn-secondary text-sm flex items-center gap-1 text-red-600 hover:text-red-700">
                <Trash2 className="w-4 h-4" /> Remove
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Personal Information</h3>
          {!editing && (
            <button onClick={() => setEditing(true)} className="btn-secondary text-sm flex items-center gap-1">
              <Edit className="w-3 h-3" /> Edit
            </button>
          )}
        </div>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">First Name</label>
              {editing ? (
                <input type="text" value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} className="input-field" />
              ) : (
                <p className="text-sm text-gray-900">{profile.first_name}</p>
              )}
            </div>
            <div>
              <label className="form-label">Last Name</label>
              {editing ? (
                <input type="text" value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} className="input-field" />
              ) : (
                <p className="text-sm text-gray-900">{profile.last_name}</p>
              )}
            </div>
          </div>
          <div>
            <label className="form-label">Email</label>
            {editing ? (
              <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="input-field" />
            ) : (
              <p className="text-sm text-gray-900">{profile.email}</p>
            )}
          </div>
          {editing && (
            <div className="flex gap-2">
              <button onClick={() => { setEditing(false); setForm({ firstName: profile.first_name, lastName: profile.last_name, email: profile.email }); }} className="btn-secondary">Cancel</button>
              <button onClick={handleSaveProfile} disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save'}</button>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Roles & Permissions</h3>
        </div>
        <div className="space-y-3">
          <div>
            <label className="form-label">Roles</label>
            <div className="flex flex-wrap gap-2">
              {profile.roles.filter(Boolean).map(r => (
                <span key={r} className="badge-blue flex items-center gap-1"><Shield className="w-3 h-3" />{r}</span>
              ))}
            </div>
          </div>
          <div>
            <label className="form-label">Permissions ({profile.permissions.filter(Boolean).length})</label>
            <div className="flex flex-wrap gap-1">
              {profile.permissions.filter(Boolean).map(p => (
                <span key={p} className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">{p}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Security</h3>
          {!showPassword && (
            <button onClick={() => setShowPassword(true)} className="btn-secondary text-sm flex items-center gap-1">
              <Lock className="w-3 h-3" /> Change Password
            </button>
          )}
        </div>
        {showPassword ? (
          <form onSubmit={handleChangePassword} className="space-y-3">
            <div>
              <label className="form-label">Current Password</label>
              <input type="password" required value={passwordForm.currentPassword} onChange={e => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className="form-label">New Password</label>
              <input type="password" required minLength={6} value={passwordForm.newPassword} onChange={e => setPasswordForm({ ...passwordForm, newPassword: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className="form-label">Confirm New Password</label>
              <input type="password" required minLength={6} value={passwordForm.confirmPassword} onChange={e => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })} className="input-field" />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowPassword(false)} className="btn-secondary">Cancel</button>
              <button type="submit" disabled={changingPassword} className="btn-primary">{changingPassword ? 'Changing...' : 'Change Password'}</button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-gray-500">Last changed: Unknown</p>
        )}
      </div>

      <div className="card">
        <h3 className="font-semibold mb-4">Account Info</h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="flex items-center gap-2"><User className="w-4 h-4 text-gray-400" /><div><p className="text-gray-500">Status</p><p className="font-medium">{profile.is_active ? 'Active' : 'Inactive'}</p></div></div>
          <div className="flex items-center gap-2"><Clock className="w-4 h-4 text-gray-400" /><div><p className="text-gray-500">Member Since</p><p className="font-medium">{new Date(profile.created_at).toLocaleDateString()}</p></div></div>
          <div className="flex items-center gap-2"><Clock className="w-4 h-4 text-gray-400" /><div><p className="text-gray-500">Last Login</p><p className="font-medium">{profile.last_login_at ? new Date(profile.last_login_at).toLocaleString() : 'Never'}</p></div></div>
        </div>
      </div>

      {profile.loginHistory?.length > 0 && (
        <div className="card">
          <h3 className="font-semibold mb-4">Recent Logins</h3>
          <div className="space-y-2">
            {profile.loginHistory.slice(0, 5).map((login, i) => (
              <div key={i} className="flex justify-between text-sm py-2 border-b last:border-0">
                <span className="text-gray-900">{new Date(login.created_at).toLocaleString()}</span>
                <span className="text-gray-500">{login.ip_address || 'Unknown'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
