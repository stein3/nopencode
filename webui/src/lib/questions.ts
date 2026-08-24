import { pendingQuestions, type PendingQuestion } from './stores'
import { oc } from './api'

// Engine question-tool request shape (v1.18.x):
// { id, sessionID, questions: [{question, header, options, multiple?, custom?}],
//   tool?: { messageID, callID } }
// While a question is pending the engine holds the turn open (session busy);
// reply with { answers: string[][] } — one label array per question, in order.

export function refreshQuestions() {
  return oc
    .questions()
    .then((raw: any[]) => {
      const list: PendingQuestion[] = (Array.isArray(raw) ? raw : []).filter((q) => q?.id)
      pendingQuestions.set(list)
    })
    .catch(() => pendingQuestions.set([]))
}

export async function answerQuestion(req: PendingQuestion, answers: string[][]) {
  try {
    await oc.replyQuestion(req.id, answers)
  } finally {
    refreshQuestions()
  }
}

export async function dismissQuestion(req: PendingQuestion) {
  try {
    await oc.rejectQuestion(req.id)
  } finally {
    refreshQuestions()
  }
}
