import { expect, test } from 'bun:test';
import { PageHandoff } from './page-handoff';

test('目标回执到达前不完成切换，拒绝重复请求及错误令牌', async () => {
  const handoff = new PageHandoff();
  let token = '';
  let completed = false;
  const transfer = handoff.open('http://127.0.0.1:4173', async url => {
    token = new URL(url).searchParams.get('handoff')!;
  }).then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(handoff.acknowledge('wrong')).toBe(false);
  await expect(handoff.open('http://127.0.0.1:4173', async () => {})).rejects.toThrow('正在切换');
  expect(handoff.acknowledge(token)).toBe(true);
  await transfer;
  expect(completed).toBe(true);
  expect(handoff.acknowledge(token)).toBe(false);
});

test('超时和启动失败后清理回执，允许重试且拒绝过期回执', async () => {
  const handoff = new PageHandoff();
  let expired = '';
  await expect(handoff.open('http://127.0.0.1:4173', async url => {
    expired = new URL(url).searchParams.get('handoff')!;
  }, 15)).rejects.toThrow('未关闭原页面');
  expect(handoff.acknowledge(expired)).toBe(false);
  await expect(handoff.open('http://127.0.0.1:4173', async () => { throw new Error('启动失败'); })).rejects.toThrow('启动失败');
  await handoff.open('http://127.0.0.1:4173', async url => {
    expect(handoff.acknowledge(expired)).toBe(false);
    expect(handoff.acknowledge(new URL(url).searchParams.get('handoff'))).toBe(true);
  });
});
