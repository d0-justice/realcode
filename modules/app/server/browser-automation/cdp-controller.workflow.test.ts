import { expect, test } from 'bun:test';
import { CdpController } from './cdp-controller';

test('search and play waits across pages and reports success only after playback', async () => {
  const controller = Object.create(CdpController.prototype) as any;
  const called: string[] = [];
  controller.waitForSiteTool = async () => {};
  controller.callSiteTool = async (name: string) => {
    called.push(name);
    if (name.endsWith('listResults')) return { status: 'arrived', results: [{ resultId: 'BV123', title: 'RAG 入门', url: 'https://www.bilibili.com/video/BV123/' }] };
    if (name.endsWith('openResult')) return { status: 'navigation_started' };
    if (name.endsWith('getVideoInfo')) return { status: 'arrived', resultId: 'BV123', title: 'RAG 入门', url: 'https://www.bilibili.com/video/BV123/' };
    return { status: 'playing' };
  };
  const result = await controller.finishSearchAndPlay('rag', { status: 'navigation_started' });
  expect(result).toEqual({ status: 'playing', query: 'rag', resultId: 'BV123', title: 'RAG 入门', url: 'https://www.bilibili.com/video/BV123/' });
  expect(called).toEqual(['realcode.bilibili.listResults', 'realcode.bilibili.openResult', 'realcode.bilibili.getVideoInfo', 'realcode.bilibili.playVideo']);
});

test('search and play does not claim success when playback fails', async () => {
  const controller = Object.create(CdpController.prototype) as any;
  controller.waitForSiteTool = async () => {};
  controller.callSiteTool = async (name: string) => {
    if (name.endsWith('listResults')) return { status: 'arrived', results: [{ resultId: 'BV123', title: 'RAG 入门', url: 'https://www.bilibili.com/video/BV123/' }] };
    if (name.endsWith('openResult')) return { status: 'navigation_started' };
    if (name.endsWith('getVideoInfo')) return { status: 'arrived', resultId: 'BV123' };
    return { status: 'user_gesture_required' };
  };
  await expect(controller.finishSearchAndPlay('rag', { status: 'navigation_started' })).rejects.toThrow('播放未成功');
});
