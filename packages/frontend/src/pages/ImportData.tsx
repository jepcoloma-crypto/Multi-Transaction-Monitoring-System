import { useState, useCallback } from 'react';
import { api } from '../lib/api';
import { Upload, FileText, Download, CheckCircle, XCircle, AlertCircle } from 'lucide-react';

type ImportType = 'transactions' | 'accounts' | 'loading';

interface ImportResult {
  created: number; failed: number; errors: string[];
}

export default function ImportData() {
  const [activeTab, setActiveTab] = useState<ImportType>('transactions');
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [accountId, setAccountId] = useState('');

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped && (dropped.name.endsWith('.csv') || dropped.name.endsWith('.json'))) {
      setFile(dropped);
      setResult(null);
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) { setFile(selected); setResult(null); }
  };

  const handleImport = async () => {
    if (!file) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (accountId) formData.append('accountId', accountId);
      const data = await api.post<any>(`/import/${activeTab}`, formData, true);
      setResult(data);
    } catch (err: any) {
      setResult({ created: 0, failed: 1, errors: [err.response?.data?.error?.message || err.message || 'Import failed'] });
    } finally { setImporting(false); }
  };

  const downloadTemplate = async (type: ImportType) => {
    try {
      const res = await fetch(`/api/import/template/${type}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${type}_template.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { console.error('Import template download error:', err); }
  };

  const tabs: { id: ImportType; label: string; desc: string; fields: string[] }[] = [
    { id: 'transactions', label: 'Transactions', desc: 'Import transaction records', fields: ['account_id', 'type_name', 'amount', 'fee', 'reference_number', 'description', 'transaction_date'] },
    { id: 'accounts', label: 'Accounts', desc: 'Import new accounts', fields: ['name', 'provider', 'type', 'masked_account_number', 'opening_balance', 'minimum_balance', 'target_balance'] },
    { id: 'loading', label: 'Loading Sales', desc: 'Import loading transactions', fields: ['account_id', 'product_name', 'customer_number', 'quantity'] },
  ];

  const currentTab = tabs.find(t => t.id === activeTab)!;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Data Import</h2>
        <p className="text-sm text-gray-600">Import data from CSV or JSON files</p>
      </div>

      <div className="flex gap-2">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => { setActiveTab(tab.id); setFile(null); setResult(null); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === tab.id ? 'bg-primary-100 text-primary-700 border border-primary-200' : 'text-gray-600 hover:bg-gray-100'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Upload File</h3>
              <button onClick={() => downloadTemplate(activeTab)} className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1">
                <Download className="w-4 h-4" /> Download Template
              </button>
            </div>

            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${dragOver ? 'border-primary-400 bg-primary-50' : 'border-gray-300 hover:border-gray-400'}`}
              onClick={() => document.getElementById('file-input')?.click()}
            >
              <input id="file-input" type="file" accept=".csv,.json" onChange={handleFileChange} className="hidden" />
              {file ? (
                <div className="space-y-2">
                  <FileText className="w-10 h-10 mx-auto text-primary-500" />
                  <p className="font-medium text-gray-900">{file.name}</p>
                  <p className="text-sm text-gray-500">{(file.size / 1024).toFixed(1)} KB</p>
                  <button onClick={e => { e.stopPropagation(); setFile(null); setResult(null); }} className="text-sm text-red-500 hover:text-red-700">Remove</button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="w-10 h-10 mx-auto text-gray-400" />
                  <p className="font-medium text-gray-700">Drag & drop a CSV or JSON file here</p>
                  <p className="text-sm text-gray-500">or click to browse</p>
                </div>
              )}
            </div>

            {(activeTab === 'transactions' || activeTab === 'loading') && (
              <div className="mt-4">
                <label className="form-label">Default Account ID (optional)</label>
                <input type="text" value={accountId} onChange={e => setAccountId(e.target.value)} className="input-field" placeholder="UUID - used when account_id is missing in rows" />
              </div>
            )}

            <div className="mt-4 flex gap-3">
              <button onClick={handleImport} disabled={!file || importing} className="btn-primary flex items-center gap-2 disabled:opacity-50">
                <Upload className="w-4 h-4" /> {importing ? 'Importing...' : 'Import Data'}
              </button>
            </div>
          </div>

          {result && (
            <div className={`card ${result.failed > 0 ? 'border-yellow-200 bg-yellow-50' : 'border-green-200 bg-green-50'}`}>
              <div className="flex items-center gap-3 mb-3">
                {result.failed > 0 ? <AlertCircle className="w-5 h-5 text-yellow-600" /> : <CheckCircle className="w-5 h-5 text-green-600" />}
                <h4 className="font-semibold">Import Complete</h4>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="flex items-center gap-2"><CheckCircle className="w-4 h-4 text-green-500" /><span>{result.created} created</span></div>
                <div className="flex items-center gap-2"><XCircle className="w-4 h-4 text-red-500" /><span>{result.failed} failed</span></div>
              </div>
              {result.errors.length > 0 && (
                <div className="mt-3">
                  <p className="text-sm font-medium text-gray-700 mb-1">Errors:</p>
                  <div className="max-h-40 overflow-y-auto text-xs text-red-600 space-y-1">
                    {result.errors.map((err, i) => <p key={i}>- {err}</p>)}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="lg:col-span-1">
          <div className="card">
            <h3 className="font-semibold mb-3">Expected Columns</h3>
            <p className="text-sm text-gray-500 mb-3">{currentTab.desc}</p>
            <div className="space-y-2">
              {currentTab.fields.map(field => (
                <div key={field} className="flex items-center gap-2 text-sm">
                  <code className="bg-gray-100 px-2 py-0.5 rounded text-xs font-mono">{field}</code>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-3 border-t">
              <p className="text-xs text-gray-500">Supported formats: CSV, JSON</p>
              <p className="text-xs text-gray-500">Max file size: 10 MB</p>
            </div>
          </div>

          <div className="card mt-4">
            <h3 className="font-semibold mb-3">Tips</h3>
            <ul className="text-sm text-gray-600 space-y-2">
              <li>- Download the template first for correct column names</li>
              <li>- Account IDs should be UUIDs from the Accounts page</li>
              <li>- Transaction types must match existing type names exactly</li>
              <li>- Loading product names must match existing products</li>
              <li>- Dates should be ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ)</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
