function pickErrorMessage(data, fallback) {
  if (data?.error?.message) return data.error.message;
  if (typeof data?.error === 'string') return data.error;
  if (typeof data?.message === 'string') return data.message;
  return fallback;
}

function looksLikeHtml(text) {
  const trimmed = String(text || '').trim().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.includes('<body');
}

export async function parsePaperResponse(response, url = '') {
  const contentType = response.headers?.get?.('content-type') || '';
  const bodyText = await response.text();
  const isJson = contentType.includes('application/json') || bodyText.trim().startsWith('{') || bodyText.trim().startsWith('[');

  if (!isJson || looksLikeHtml(bodyText)) {
    const target = url ? `（${url}）` : '';
    throw new Error(`模拟交易 API 返回了页面 HTML${target}，请确认当前页面端口和后端服务一致，并强制刷新页面后重试`);
  }

  let data;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    throw new Error(`模拟交易 API 返回了无法解析的 JSON${url ? `（${url}）` : ''}`);
  }

  if (!response.ok) {
    throw new Error(pickErrorMessage(data, `HTTP ${response.status}`));
  }

  return data;
}
