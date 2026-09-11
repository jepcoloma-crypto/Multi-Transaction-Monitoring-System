const API_BASE = '/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('accessToken');
  const isFormData = options.body instanceof FormData;
  const headers: Record<string, string> = isFormData
    ? { ...(options.headers as Record<string, string>) }
    : { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || 'Request failed');
  }

  return data.data;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: any, isFormData = false) => request<T>(path, {
    method: 'POST',
    body: isFormData ? body : body ? JSON.stringify(body) : undefined,
  }),
  put: <T>(path: string, body: any) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: any) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
