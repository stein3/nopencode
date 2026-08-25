import { pendingQuestions, toast, type PendingQuestion } from './stores'
import { oc } from './api'

// Engine question-tool request shape (v1.18.x):
// { id, sessionID, questions: [{question, header, options, multiple?, custom?}],
//   tool?: { messageID, callID } }
// While a question is pending the engine holds the turn open (session busy);
// reply with { answers: string[][] } — one label array per question, in order.

let lastJson = ''

export function refreshQuestions() {
  return oc
    .questions()
    .then((raw: any[]) => {
      const list: PendingQuestion[] = (Array.isArray(raw) ? raw : []).filter((q) => q?.id)
      setQuestions(list)
    })
    .catch(() => setQuestions([]))
}

// writable.set notifies subscribers unconditionally, and every notify hands
// pickers fresh request objects. Skip identical payloads so unrelated
// question.* events (any session/client) can't churn the store.
function setQuestions(list: PendingQuestion[]) {
  const json = JSON.stringify(list)
  if (json === lastJson) return
  lastJson = json
  pendingQuestions.set(list)
}

export async function answerQuestion(req: PendingQuestion, answers: string[][]) {
  try {
    await oc.replyQuestion(req.id, answers)
  } catch (e: any) {
    // surface failures (404 = another client answered first, network, …) —
    // an unhandled rejection here looked like a dead click
    toast(`answer failed: ${e?.message ?? e}`)
  } finally {
    refreshQuestions()
  }
}

export async function dismissQuestion(req: PendingQuestion) {
  try {
    await oc.rejectQuestion(req.id)
  } catch (e: any) {
    toast(`dismiss failed: ${e?.message ?? e}`)
  } finally {
    refreshQuestions()
  }
}
