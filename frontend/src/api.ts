export async function api<T>(path:string, options:RequestInit = {}):Promise<T> {
  const response = await fetch(path, { ...options, headers:{ ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers } });
  const data = response.status===204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.error || 'Could not complete this request');
  return data as T;
}
