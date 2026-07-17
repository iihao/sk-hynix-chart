export function createBinanceTransport<T>(options: {
  proxyUrl?: string;
  directRequest: (path: string) => Promise<T>;
  proxyRequest?: (path: string, proxyUrl: string) => Promise<T>;
}) {
  let preferred: 'proxy' | 'direct' = options.proxyUrl ? 'proxy' : 'direct';

  async function request(path: string): Promise<{data: T; transport: 'proxy' | 'direct'}> {
    if (preferred === 'proxy' && options.proxyUrl && options.proxyRequest) {
      try {
        const data = await options.proxyRequest(path, options.proxyUrl);
        return {data, transport: 'proxy'};
      } catch {
        preferred = 'direct';
      }
    }
    try {
      const data = await options.directRequest(path);
      preferred = 'direct';
      return {data, transport: 'direct'};
    } catch (error) {
      if (options.proxyUrl && options.proxyRequest && preferred !== 'proxy') {
        const data = await options.proxyRequest(path, options.proxyUrl);
        preferred = 'proxy';
        return {data, transport: 'proxy'};
      }
      throw error;
    }
  }

  return {request, preferred: () => preferred};
}
