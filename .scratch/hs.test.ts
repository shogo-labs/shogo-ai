import { test } from 'bun:test'
import { chatHistoryLimits, chatHistoryKey, writeChatHistory, readChatHistory, setChatHistoryBackend, getChatHistoryBackend } from '../apps/mobile/lib/chat-history-store'
test('dbg', async () => {
  console.log('limits', chatHistoryLimits(), getChatHistoryBackend())
  for (let i=0;i<25;i++) {
    await writeChatHistory('project', chatHistoryKey('u1','o',`s${i}`), { messages: [{id:`m${i}`}], cursor: null, total: 1, hasMoreOlder: false, savedAt: i })
  }
  const all = await Promise.all(Array.from({length:25},(_,i)=>readChatHistory('project', chatHistoryKey('u1','o',`s${i}`))))
  console.log('kept', all.filter(Boolean).length, 'first', all[0])
})
