export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, options); }
  catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new Error('无法连接本地服务，请保持启动窗口开启。');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`服务未返回有效数据 (${response.status})，请稍后重试。`); }
  if (!response.ok)
    throw new Error(data.message || data.error || `请求失败 (${response.status})`);
  return data as T;
}
export const jsonPost = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
