import React, { useState, useRef, useEffect } from 'react';
import { Send, RefreshCw, ClipboardList, HelpCircle, AlertCircle, Sparkles, Copy, Check, Clock, Activity, Pill, History, Printer, User, Moon, Sun, Calendar, Stethoscope, Building2 } from 'lucide-react';

const STORAGE_KEY = 'visitready_session';

const INTERVIEWER_SYSTEM_INSTRUCTION = `You are the Interviewer agent for VisitReady, a conversational assistant that helps patients prepare for their doctor's appointment.
Your role: Interview the patient one question at a time to gather the following 6 pieces of information in order:
(1) main symptom/concern
(2) when it started
(3) severity (mild, moderate, or severe) and whether it is constant or comes and goes
(4) what makes it better or worse
(5) current medications and allergies
(6) relevant medical history

Tone: warm, calm, brief. Keep your responses short, supportive, and empathetic.

Critical Rules:
- Ask ONLY ONE question at a time.
- Read the conversation history carefully. If the patient has already provided some of these details in previous messages, do NOT ask for them again. Instead, move to the next missing detail.
- If the patient provides multiple details at once, acknowledge them briefly and ask about the remaining details.
- NEVER diagnose or suggest a specific condition or treatment. Never say things like "It could be a migraine" or "You might have flu".
- Always defer medical judgment to the doctor.
- When you have successfully gathered all 6 details (or the patient cannot or does not want to provide more details), write a brief friendly concluding statement, and append "[[COMPLETE]]" at the very end of your response.`;

const SUMMARIZER_SYSTEM_INSTRUCTION = `You are the Summarizer agent for VisitReady.
Your role: Take the full interview transcript between the Interviewer and the patient, and produce a structured "Visit Prep Sheet".
The Visit Prep Sheet must have exactly these sections:
- Summary of Concern: A clear, concise summary of the patient's main symptom/concern.
- Timeline: When the symptom started and how long it has been going on.
- Severity & Pattern: The severity (mild/moderate/severe) and whether it is constant or comes and goes.
- Aggravating/Relieving Factors: What makes it better or worse.
- Current Medications: Current medications and allergies.
- Relevant History: Any relevant medical history.

Critical Rules:
- Be strictly factual, based ONLY on what was actually said in the transcript.
- Do NOT diagnose or suggest any conditions.
- Do NOT speculate or add any medical details not provided by the patient.
- Defer all medical judgment to the doctor.
- Format the output in clean Markdown with '### Section Name' headers.`;

const QUESTION_GENERATOR_SYSTEM_INSTRUCTION = `You are the Question Generator agent for VisitReady.
Your role: Take the Summarizer's structured output (the Visit Prep Sheet) and generate 3 to 4 specific, relevant questions the patient should ask their doctor.

Critical Rules:
- The questions must be tailored to this specific patient's case, based on what they actually shared.
- Do NOT make the questions generic.
- Never diagnose, suggest a specific condition or treatment.
- Always defer medical judgment to the doctor.
- Format the questions as a simple bulleted list starting with '-' or '*'.`;

const INITIAL_MESSAGE = {
  sender: 'bot',
  text: "Hello! I am your VisitReady assistant. I'll help you prepare for your upcoming doctor's appointment by asking a few brief questions. First, what is the main symptom or concern you'd like to discuss with your doctor today?"
};

const INTERVIEW_STEPS = [
  { label: 'Concern' },
  { label: 'Timeline' },
  { label: 'Severity' },
  { label: 'Factors' },
  { label: 'Meds' },
  { label: 'History' },
];

const parsePrepSheet = (text) => {
  if (!text) return null;
  const sections = {
    summaryOfConcern: '',
    timeline: '',
    severityPattern: '',
    aggravatingRelieving: '',
    currentMedications: '',
    relevantHistory: ''
  };
  const lines = text.split('\n');
  let currentKey = null;
  let contentBuffer = [];
  const headerMap = {
    'summary of concern': 'summaryOfConcern',
    'timeline': 'timeline',
    'severity & pattern': 'severityPattern',
    'severity and pattern': 'severityPattern',
    'aggravating/relieving factors': 'aggravatingRelieving',
    'aggravating and relieving factors': 'aggravatingRelieving',
    'aggravating/relieving': 'aggravatingRelieving',
    'current medications': 'currentMedications',
    'medications': 'currentMedications',
    'relevant history': 'relevantHistory',
    'history': 'relevantHistory'
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || (trimmed.startsWith('**') && trimmed.endsWith('**') && trimmed.length < 50)) {
      if (currentKey) sections[currentKey] = contentBuffer.join('\n').trim();
      contentBuffer = [];
      const title = trimmed.replace(/[#\*]+/g, '').toLowerCase().replace(/[:\-\s]+$/, '').trim();
      currentKey = null;
      for (const [headerText, key] of Object.entries(headerMap)) {
        if (title.includes(headerText) || headerText.includes(title)) { currentKey = key; break; }
      }
    } else {
      if (currentKey) contentBuffer.push(line);
    }
  }
  if (currentKey && contentBuffer.length > 0) sections[currentKey] = contentBuffer.join('\n').trim();
  if (!sections.summaryOfConcern && !sections.timeline && !sections.severityPattern) return null;
  return sections;
};

const detectSeverity = (text) => {
  if (!text) return 'unknown';
  const lower = text.toLowerCase();
  if (lower.includes('severe') || lower.includes('high severity')) return 'severe';
  if (lower.includes('moderate') || lower.includes('medium severity')) return 'moderate';
  if (lower.includes('mild') || lower.includes('low severity')) return 'mild';
  return 'unknown';
};

const deriveStep = (messages) => Math.min(messages.filter(m => m.sender === 'user').length, 6);

export default function App() {
  const [messages, setMessages] = useState([INITIAL_MESSAGE]);
  const [inputValue, setInputValue] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [interviewComplete, setInterviewComplete] = useState(false);
  const [prepSheet, setPrepSheet] = useState('');
  const [doctorQuestions, setDoctorQuestions] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [darkMode, setDarkMode] = useState(() => { try { return localStorage.getItem('visitready_dark') === 'true'; } catch { return false; } });
  const [showRestoreBanner, setShowRestoreBanner] = useState(false);
  const [savedSession, setSavedSession] = useState(null);

  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    try { localStorage.setItem('visitready_dark', darkMode); } catch {}
  }, [darkMode]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.messages?.length > 1) { setSavedSession(parsed); setShowRestoreBanner(true); }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (messages.length <= 1 && !prepSheet) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, interviewComplete, prepSheet, doctorQuestions }));
    } catch {}
  }, [messages, interviewComplete, prepSheet, doctorQuestions]);

  const handleRestoreSession = () => {
    setMessages(savedSession.messages || [INITIAL_MESSAGE]);
    setInterviewComplete(savedSession.interviewComplete || false);
    setPrepSheet(savedSession.prepSheet || '');
    setDoctorQuestions(savedSession.doctorQuestions || '');
    setShowRestoreBanner(false); setSavedSession(null);
  };

  const handleDismissRestore = () => {
    setShowRestoreBanner(false); setSavedSession(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  };

  useEffect(() => {
    if (retryCountdown <= 0) { if (error === 'rate_limit') inputRef.current?.focus(); return; }
    const timer = setTimeout(() => setRetryCountdown(prev => prev - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryCountdown, error]);

  useEffect(() => { if (!isGenerating && !interviewComplete) inputRef.current?.focus(); }, [isGenerating, interviewComplete]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const handleCopyToClipboard = () => {
    if (!prepSheet) return;
    const cleanPrep = prepSheet.replace(/###\s+/g, '\n* ').replace(/\*\*/g, '').trim();
    const cleanQuestions = doctorQuestions.replace(/[-\*]\s+/g, '* ').trim();
    const fullText = `VISIT PREP SHEET\n------------------\n${cleanPrep}\n\nQUESTIONS TO ASK YOUR DOCTOR\n------------------\n${cleanQuestions}\n\nDisclaimer: VisitReady helps you prepare - it does not diagnose. Always consult a doctor.`;
    setCopied(true); setTimeout(() => setCopied(false), 2000);
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(fullText).catch(() => fallbackCopyText(fullText)); }
    else { fallbackCopyText(fullText); }
  };

  const fallbackCopyText = (text) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.focus(); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    } catch {}
  };

  const handlePrint = () => window.print();

  const callGemini = async (contents, systemInstructionText = '') => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');
    const models = ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash'];
    let lastError = null;
    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const payload = { contents };
        if (systemInstructionText) payload.systemInstruction = { parts: [{ text: systemInstructionText }] };
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!response.ok) { const errData = await response.json().catch(() => ({})); throw new Error(errData?.error?.message || `HTTP error ${response.status}`); }
        const data = await response.json();
        return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      } catch (err) { console.warn(`Model ${model} failed:`, err); lastError = err; }
    }
    throw new Error(`All models failed: ${lastError?.message}`);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!inputValue.trim() || isGenerating || interviewComplete) return;
    const userMessage = { sender: 'user', text: inputValue };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages); setInputValue(''); setIsGenerating(true); setError('');
    try {
      const contents = updatedMessages.map(msg => ({ role: msg.sender === 'user' ? 'user' : 'model', parts: [{ text: msg.text }] }));
      const botResponse = await callGemini(contents, INTERVIEWER_SYSTEM_INSTRUCTION);
      const isConcluded = botResponse.includes('[[COMPLETE]]');
      const cleanBotResponse = botResponse.replace('[[COMPLETE]]', '').trim();
      setMessages(prev => [...prev, { sender: 'bot', text: cleanBotResponse }]);
      if (isConcluded) { setInterviewComplete(true); await handleGeneratePrepSheet(updatedMessages.concat({ sender: 'bot', text: cleanBotResponse })); }
    } catch (err) {
      const errMsg = err.message || '';
      if (errMsg.includes('429') || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('limit')) { setError('rate_limit'); setRetryCountdown(60); }
      else { setError(errMsg || 'Something went wrong. Please try again.'); }
    } finally { setIsGenerating(false); }
  };

  const handleGeneratePrepSheet = async (fullConversation) => {
    setIsGenerating(true); setError('');
    try {
      const transcript = fullConversation.map(msg => `${msg.sender === 'user' ? 'Patient' : 'Interviewer'}: ${msg.text}`).join('\n');
      const prepSheetOutput = await callGemini([{ role: 'user', parts: [{ text: `Here is the interview transcript:\n\n${transcript}` }] }], SUMMARIZER_SYSTEM_INSTRUCTION);
      setPrepSheet(prepSheetOutput);
      const questionsOutput = await callGemini([{ role: 'user', parts: [{ text: `Here is the Visit Prep Sheet:\n\n${prepSheetOutput}` }] }], QUESTION_GENERATOR_SYSTEM_INSTRUCTION);
      setDoctorQuestions(questionsOutput);
    } catch (err) {
      const errMsg = err.message || '';
      if (errMsg.includes('429') || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('limit')) { setError('rate_limit'); setRetryCountdown(60); }
      else { setError(errMsg || 'Failed to generate prep sheet. Please try resetting.'); }
    } finally { setIsGenerating(false); }
  };

  const handleReset = () => {
    setMessages([INITIAL_MESSAGE]); setInputValue(''); setIsGenerating(false); setInterviewComplete(false);
    setPrepSheet(''); setDoctorQuestions(''); setError(''); setRetryCountdown(0);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  };

  const renderMarkdown = (text) => {
    if (!text) return null;
    return text.split('\n').map((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('###')) return <h4 key={i} className="prep-section-title">{trimmed.replace(/^###\s*/, '')}</h4>;
      if (trimmed.startsWith('##')) return <h3 key={i} className="prep-section-title-large">{trimmed.replace(/^##\s*/, '')}</h3>;
      if (trimmed.startsWith('#')) return <h2 key={i} className="prep-title">{trimmed.replace(/^#\s*/, '')}</h2>;
      if (trimmed.startsWith('-') || trimmed.startsWith('*')) return <li key={i} className="prep-bullet">{parseBold(trimmed.replace(/^[-*]\s*/, ''))}</li>;
      if (trimmed === '') return <div key={i} className="prep-space" />;
      return <p key={i} className="prep-text">{parseBold(trimmed)}</p>;
    });
  };

  const parseBold = (text) => text.split(/(\*\*.*?\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part
  );

  const currentStep = deriveStep(messages);
  const parsed = parsePrepSheet(prepSheet);
  const severity = parsed ? detectSeverity(parsed.severityPattern || '') : 'unknown';

  return (
    <div className="app-container">

      {showRestoreBanner && (
        <div className="session-restore-banner">
          <span className="restore-icon">&#x1F4BE;</span>
          <span className="restore-text">You have an unfinished session. Would you like to continue where you left off?</span>
          <div className="restore-actions">
            <button className="btn-restore-yes" onClick={handleRestoreSession}>Continue Session</button>
            <button className="btn-restore-no" onClick={handleDismissRestore}>Start Fresh</button>
          </div>
        </div>
      )}

      <header className="app-header">
        <div className="header-content">
          <div className="logo-section">
            <div className="logo-icon-wrapper">
              <Sparkles className="logo-icon" />
            </div>
            <div>
              <h1 className="logo-title">VisitReady</h1>
              <p className="logo-tagline">Walk into your doctor's appointment prepared, not panicked.</p>
            </div>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn-icon-toggle" onClick={() => setDarkMode(d => !d)} title={darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'} aria-label="Toggle dark mode">
            {darkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="btn-reset" onClick={handleReset} title="Reset Interview">
            <RefreshCw size={18} />
            <span>Start Over</span>
          </button>
        </div>
      </header>

      <main className="app-main">
        <div className="content-grid">

          <div className={`panel chat-panel ${interviewComplete ? 'split-view' : 'full-view'}`}>
            <div className="panel-header">
              <div className="panel-title-wrapper">
                <span className="status-indicator active"></span>
                <h3>Medical Interview</h3>
              </div>
              <div className="panel-header-right">
                <svg className="ekg-line" viewBox="0 0 120 30" xmlns="http://www.w3.org/2000/svg">
                  <polyline points="0,15 20,15 28,5 34,25 40,10 46,20 52,15 72,15 80,5 86,25 92,10 98,20 104,15 120,15"
                    fill="none" stroke="rgba(55,124,112,0.35)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {interviewComplete && <span className="badge-complete">Interview Concluded</span>}
              </div>
            </div>

            {!interviewComplete && (
              <div className="progress-tracker">
                {INTERVIEW_STEPS.map((step, idx) => {
                  const isDone = currentStep > idx;
                  const isActive = currentStep === idx;
                  return (
                    <React.Fragment key={idx}>
                      <div className={`progress-step ${isDone ? 'done' : ''} ${isActive ? 'active' : ''}`}>
                        <div className="step-dot">
                          {isDone ? <Check size={9} strokeWidth={3} /> : <span className="step-num">{idx + 1}</span>}
                        </div>
                        <span className="step-label">{step.label}</span>
                      </div>
                      {idx < INTERVIEW_STEPS.length - 1 && (
                        <div className={`step-connector ${isDone ? 'done' : ''}`} />
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            )}

            <div className="chat-messages-container">
              {messages.map((msg, index) => (
                <div key={index} className={`message-bubble-wrapper ${msg.sender}`}>
                  {msg.sender === 'bot' && <div className="avatar bot-avatar"><Sparkles size={14} /></div>}
                  <div className="message-bubble"><p className="message-text">{msg.text}</p></div>
                  {msg.sender === 'user' && <div className="avatar user-avatar"><User size={14} /></div>}
                </div>
              ))}
              {isGenerating && !prepSheet && (
                <div className="message-bubble-wrapper bot">
                  <div className="avatar bot-avatar"><Sparkles size={14} /></div>
                  <div className="message-bubble loading-bubble">
                    <span className="dot"></span><span className="dot"></span><span className="dot"></span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {error && (
              <div className="error-banner">
                <AlertCircle size={18} />
                <span>
                  {error === 'rate_limit'
                    ? (retryCountdown > 0 ? `Our assistant is resting temporarily. Please wait ${retryCountdown}s before trying again.` : 'Rate limit window cleared. You can now try sending your message again!')
                    : error}
                </span>
              </div>
            )}

            <form onSubmit={handleSendMessage} className="chat-input-wrapper">
              <input ref={inputRef} type="text"
                placeholder={interviewComplete ? 'Interview complete. Review your Prep Sheet.' : retryCountdown > 0 ? `Please wait ${retryCountdown}s before retrying...` : 'Type your response here...'}
                value={inputValue} onChange={(e) => setInputValue(e.target.value)}
                disabled={isGenerating || interviewComplete || retryCountdown > 0} className="chat-input" />
              <button type="submit" disabled={!inputValue.trim() || isGenerating || interviewComplete || retryCountdown > 0} className="btn-send">
                <Send size={18} />
              </button>
            </form>
          </div>

          {(prepSheet || (interviewComplete && isGenerating)) && (
            <div className="panel prep-panel fade-in">
              <div className="panel-header bg-teal">
                <div className="panel-title-wrapper">
                  <ClipboardList className="panel-header-icon" />
                  <h3>Visit Prep Sheet</h3>
                </div>
                <div className="panel-actions">
                  <button className="btn-action-outline" onClick={handleCopyToClipboard} title="Copy to Clipboard">
                    {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
                    <span>{copied ? 'Copied!' : 'Copy'}</span>
                  </button>
                  <button className="btn-action-outline" onClick={handlePrint} title="Print Prep Sheet">
                    <Printer size={16} /><span>Print</span>
                  </button>
                </div>
              </div>



              <div className="prep-content-container">
                {isGenerating && !prepSheet ? (
                  <div className="loader-container">
                    <div className="spinner"></div>
                    <p>Generating your custom visit summary...</p>
                  </div>
                ) : (
                  <>
                    <div className="prep-sheet-card printable-card">
                      <div className="prep-sheet-card-header">
                        <Sparkles size={20} className="card-header-logo" />
                        <div className="card-header-info">
                          <h3>Patient Visit Prep Sheet</h3>
                          <p className="card-date">Date: {new Date().toLocaleDateString()}</p>

                        </div>
                        {severity !== 'unknown' && (
                          <span className={`severity-badge ${severity}`}>
                            {severity.charAt(0).toUpperCase() + severity.slice(1)} Severity
                          </span>
                        )}
                      </div>

                      <div className="prep-sheet-card-body">
                        {parsed ? (
                          <div className="prep-grid">
                            {parsed.summaryOfConcern && (
                              <div className="prep-grid-item">
                                <div className="grid-item-header"><Activity className="grid-icon" size={16} /><h5>Summary of Concern</h5></div>
                                <div className="grid-item-content">{renderMarkdown(parsed.summaryOfConcern)}</div>
                              </div>
                            )}
                            {parsed.timeline && (
                              <div className="prep-grid-item">
                                <div className="grid-item-header"><Clock className="grid-icon" size={16} /><h5>Timeline</h5></div>
                                <div className="grid-item-content">{renderMarkdown(parsed.timeline)}</div>
                              </div>
                            )}
                            {parsed.severityPattern && (
                              <div className="prep-grid-item">
                                <div className="grid-item-header"><AlertCircle className="grid-icon" size={16} /><h5>Severity &amp; Pattern</h5></div>
                                <div className="grid-item-content">{renderMarkdown(parsed.severityPattern)}</div>
                              </div>
                            )}
                            {parsed.aggravatingRelieving && (
                              <div className="prep-grid-item">
                                <div className="grid-item-header"><Sparkles className="grid-icon" size={16} /><h5>Aggravating &amp; Relieving Factors</h5></div>
                                <div className="grid-item-content">{renderMarkdown(parsed.aggravatingRelieving)}</div>
                              </div>
                            )}
                            {parsed.currentMedications && (
                              <div className="prep-grid-item">
                                <div className="grid-item-header"><Pill className="grid-icon" size={16} /><h5>Current Medications &amp; Allergies</h5></div>
                                <div className="grid-item-content">{renderMarkdown(parsed.currentMedications)}</div>
                              </div>
                            )}
                            {parsed.relevantHistory && (
                              <div className="prep-grid-item">
                                <div className="grid-item-header"><History className="grid-icon" size={16} /><h5>Relevant History</h5></div>
                                <div className="grid-item-content">{renderMarkdown(parsed.relevantHistory)}</div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="raw-markdown-content">{renderMarkdown(prepSheet)}</div>
                        )}
                      </div>

                      <div className="prep-sheet-card-footer">
                        <p>VisitReady helps you prepare &mdash; it does not diagnose. Always consult a doctor.</p>
                      </div>
                    </div>

                    {doctorQuestions && (
                      <div className="doctor-questions-card-section fade-in">
                        <div className="section-header">
                          <HelpCircle className="section-icon" />
                          <h3>Questions to Ask Your Doctor</h3>
                        </div>
                        <ul className="questions-list">
                          {renderMarkdown(doctorQuestions)}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

        </div>
      </main>

      <footer className="app-footer">
        <p>VisitReady &copy; {new Date().getFullYear()} &mdash; AI-assisted doctor visit preparation. Not a medical service.</p>
      </footer>
    </div>
  );
}
