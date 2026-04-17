/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Languages, 
  Mic, 
  MicOff, 
  Volume2, 
  VolumeX, 
  History, 
  Settings2, 
  Globe,
  Loader2,
  Trash2,
  Activity,
  Play,
  Pause,
  Share2,
  User as UserIcon,
  LogIn,
  LogOut,
  Copy,
  Check,
  Menu,
  X,
  Send
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { translateText } from './services/translationService';
import { 
  db, 
  auth, 
  googleProvider, 
  signInWithPopup,
  collection, 
  doc, 
  setDoc, 
  addDoc, 
  onSnapshot, 
  query, 
  orderBy, 
  limit,
  getDoc,
  OperationType,
  handleFirestoreError
} from './firebase';
import { onAuthStateChanged, User, signOut } from 'firebase/auth';

// -- Constants --

const LANGUAGES = [
  { code: 'auto', name: 'Auto Detect', flag: '✨' },
  { code: 'en-US', name: 'English', flag: '🇺🇸' },
  { code: 'es-ES', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fr-FR', name: 'French', flag: '🇫🇷' },
  { code: 'ru-RU', name: 'Russian', flag: '🇷🇺' },
  { code: 'zh-CN', name: 'Chinese', flag: '🇨🇳' },
];

interface TranscriptItem {
  id: string;
  original: string;
  translated: string;
  timestamp: number;
  sourceLang: string;
  targetLang: string;
  speakerId?: string;
}

// -- Main Component --

// -- Utils --

// Pre-load voices for faster start
let cachedVoices: SpeechSynthesisVoice[] = [];
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  cachedVoices = window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoices = window.speechSynthesis.getVoices();
  };
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [isListening, setIsListening] = useState<'me' | 'them' | null>(null);
  const [sourceLang, setSourceLang] = useState(LANGUAGES[0]);
  const [targetLang, setTargetLang] = useState(LANGUAGES[1]);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [isTranslating, setIsTranslating] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [statusMessage, setStatusMessage] = useState('Ready');
  const [sensitivity, setSensitivity] = useState(0);
  const [copiedLink, setCopiedLink] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [manualText, setManualText] = useState('');

  // Refs for Speech Recognition and Audio Core
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const accumulatedTranscriptRef = useRef<string>('');
  const isListeningRef = useRef<'me' | 'them' | null>(null);
  const transcriptIdsRef = useRef<Set<string>>(new Set());

  // -- Actions --

  const handleSignIn = async () => {
    if (isAuthLoading) return;
    setIsAuthLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
      setStatusMessage('Signed in');
    } catch (error: any) {
      if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
        setStatusMessage('Sign in cancelled');
      } else {
        console.error("Sign in failed", error);
        setStatusMessage('Authentication error');
      }
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      if (transcriptIdsRef.current) transcriptIdsRef.current.clear();
      setTranscripts([]);
      await signOut(auth);
    } catch (error) {
      console.error("Sign out failed", error);
    }
  };

  const createRoom = async () => {
    if (!user) {
      handleSignIn();
      return;
    }
    const newRoomId = Math.random().toString(36).slice(2, 11);
    const roomPath = `rooms/${newRoomId}`;
    try {
      await setDoc(doc(db, roomPath), {
        createdAt: new Date().toISOString(),
        createdBy: user.uid,
        name: `${user.displayName}'s Session`
      });
      window.history.pushState({}, '', `?room=${newRoomId}`);
      setRoomId(newRoomId);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, roomPath);
    }
  };

  const copyRoomLink = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const speakText = useCallback((text: string, langCode: string) => {
    if (!('speechSynthesis' in window)) return;
    
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    
    // Performance: Voice pre-selection from cache
    const langPrefix = langCode.split('-')[0];
    const voice = cachedVoices.find(v => v.lang.startsWith(langPrefix)) || cachedVoices[0];
    if (voice) utterance.voice = voice;
    
    utterance.lang = langCode;
    utterance.rate = 1.15; // Increased speed for snappy response
    utterance.pitch = 1.0;
    
    window.speechSynthesis.speak(utterance);
  }, []);

  const handleConversation = useCallback(async (text: string, mode: 'me' | 'them') => {
    if (!text.trim()) return;
    if (!user && roomId) {
      setStatusMessage('Sign in to speak');
      handleSignIn();
      return;
    }
    
    setIsTranslating(true);
    
    const fromLang = mode === 'me' ? sourceLang : targetLang;
    const toLang = mode === 'me' ? targetLang : sourceLang;

    try {
      const translated = await translateText(text, fromLang.name, toLang.name);
      
      // Extract translation for speaking (remove AI metadata if multi-lang detected)
      let spokenText = translated;
      if (translated.includes('): ')) {
        spokenText = translated.split('): ').slice(1).join('): ');
      }

      const newItem: TranscriptItem = {
        id: Math.random().toString(36).slice(2, 11),
        original: text,
        translated: translated,
        timestamp: Date.now(),
        sourceLang: fromLang.code,
        targetLang: toLang.code,
      };

      // If in a room, push to Firebase
      if (roomId) {
        const msgPath = `rooms/${roomId}/messages`;
        try {
          await addDoc(collection(db, msgPath), {
            ...newItem,
            speakerId: user?.uid || 'anonymous'
          });
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, msgPath);
        }
      } else {
        // Local only mode
        if (autoSpeak) speakText(spokenText, toLang.code);
        setTranscripts(prev => [...prev, newItem]);
      }
      
      setStatusMessage('Ready');
    } catch (err) {
      console.error('Translation error', err);
      setStatusMessage('Error');
    } finally {
      setIsTranslating(false);
    }
  }, [sourceLang, targetLang, autoSpeak, speakText, roomId, user]);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Room Resolver
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomId(roomParam);
      // Clear local history when joining a room
      setTranscripts([]);
      if (transcriptIdsRef.current) transcriptIdsRef.current.clear();
    }
  }, []);

  // Real-time Message Listener
  useEffect(() => {
    if (!roomId) return;

    // Use a session start time to avoid auto-speaking old messages from the channel
    const sessionJoinTime = Date.now();

    const msgPath = `rooms/${roomId}/messages`;
    const q = query(collection(db, msgPath), orderBy('timestamp', 'asc'), limit(50));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const newTranscripts: TranscriptItem[] = [];
            snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const data = change.doc.data() as TranscriptItem & { speakerId: string };
          if (!transcriptIdsRef.current.has(change.doc.id)) {
            transcriptIdsRef.current.add(change.doc.id);
            newTranscripts.push({ ...data, id: change.doc.id });
            
            // Clean AI metadata for speech
            let spokenText = data.translated;
            if (data.translated.includes('): ')) {
              spokenText = data.translated.split('): ').slice(1).join('): ');
            }

            // Auto-speak ONLY if it's from the other person AND it's a new message in this session
            if (autoSpeak && data.speakerId !== user?.uid && data.timestamp > sessionJoinTime) {
              speakText(spokenText, data.targetLang);
            }
          }
        }
      });

      if (newTranscripts.length > 0) {
        setTranscripts(prev => [...prev, ...newTranscripts]);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, msgPath);
    });

    return () => unsubscribe();
  }, [roomId, autoSpeak, user, speakText]);

  const stopListening = useCallback(() => {
    isListeningRef.current = null;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
    
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(console.error);
      audioContextRef.current = null;
    }
    
    setSensitivity(0);
  }, []);

  const startListening = async (mode: 'me' | 'them') => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setStatusMessage('Browser not supported');
      return;
    }

    if (isListening) {
      stopListening();
      return;
    }

    // 1. Setup Speech Recognition
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true; // Use interim results to catch pending speech
    
    // Use target language if source is Auto Detect for listening (better than nothing)
    // although Web Speech doesn't support 'auto' well, so we default to source if specific
    recognition.lang = mode === 'me' 
      ? (sourceLang.code === 'auto' ? 'en-US' : sourceLang.code) 
      : targetLang.code;
    
    recognitionRef.current = recognition;
    accumulatedTranscriptRef.current = '';
    let lastFinalTranscript = '';

    recognition.onresult = (event: any) => {
      let currentFinal = '';
      let currentInterim = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          currentFinal += event.results[i][0].transcript;
        } else {
          currentInterim += event.results[i][0].transcript;
        }
      }
      
      if (currentFinal) {
        lastFinalTranscript += currentFinal;
        accumulatedTranscriptRef.current = lastFinalTranscript;
      }
      
      // Keep track of total captured including interim for the very end
      const totalSession = lastFinalTranscript + currentInterim;
      
      // Minimal UI update for performance
      if (totalSession.trim()) {
        setStatusMessage('Listening...');
      }
      
      // Store the most complete version in the ref as a fallback
      accumulatedTranscriptRef.current = totalSession;
    };

    recognition.onerror = (event: any) => {
      if (event.error === 'no-speech') return;
      
      console.error('Recognition error', event.error);
      stopListening();
      setIsListening(null);
      
      if (event.error === 'network') {
        setStatusMessage('Network timeout. Retrying...');
        // Small delay and retry if it was a network glitch while we're active
        setTimeout(() => {
          if (!isListeningRef.current) return;
          try {
            recognitionRef.current?.start();
          } catch (e) {
            setStatusMessage('Connection lost');
          }
        }, 1000);
      } else {
        setStatusMessage(`Error: ${event.error}`);
      }
    };

    recognition.onend = () => {
      // Auto-restart if we timed out from silence but user didn't stop
      if (isListeningRef.current) {
        try {
          recognitionRef.current.start();
          return;
        } catch (e) {
          console.error('Auto-restart failed', e);
        }
      }

      const finalResult = accumulatedTranscriptRef.current.trim();
      if (finalResult) {
        handleConversation(finalResult, mode);
      }
      
      setIsListening(null);
      isListeningRef.current = null;
      setSensitivity(0);
      accumulatedTranscriptRef.current = '';
      if (!finalResult) setStatusMessage('Ready');
    };

    // 2. Setup Audio Visualizer
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const audioContext = new AudioContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      analyser.fftSize = 256;
      
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const updateSensitivity = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        setSensitivity(Math.min(100, Math.round((sum / bufferLength / 128) * 100)));
        animationFrameRef.current = requestAnimationFrame(updateSensitivity);
      };

      updateSensitivity();
      recognition.start();
      setIsListening(mode);
      isListeningRef.current = mode;
      setStatusMessage(`Listening to ${mode === 'me' ? sourceLang.name : targetLang.name}...`);
    } catch (err) {
      console.error('Mic error', err);
      setStatusMessage('Mic Access Denied');
      setIsListening(null);
    }
  };

  const clearHistory = () => {
    setTranscripts([]);
    setStatusMessage('Cleared');
  };

  const handleManualSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualText.trim()) return;
    handleConversation(manualText, 'me');
    setManualText('');
  };

  const switchLanguages = () => {
    const temp = sourceLang;
    setSourceLang(targetLang);
    setTargetLang(temp);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
      
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#050510] flex items-center justify-center md:p-4">
      {/* App Overlay Container */}
      <div className="w-full h-screen md:h-[90vh] md:max-w-[1200px] bg-white/5 backdrop-blur-[40px] md:border md:border-white/10 md:rounded-[40px] overflow-hidden shadow-2xl flex flex-col md:grid md:grid-cols-[300px_1fr] relative">
        
        {/* Mobile Header */}
        <div className="md:hidden flex items-center justify-between p-4 border-b border-white/5 bg-black/20 z-40">
           <div className="flex items-center gap-3 font-bold text-lg tracking-tight">
            <div className="w-2.5 h-2.5 bg-emerald-400 rounded-full shadow-[0_0_10px_#4ade80]" />
            LinguaFuse
          </div>
          <button 
            onClick={() => setShowSidebar(!showSidebar)}
            className="p-2 rounded-lg bg-white/5 text-white/70"
          >
            {showSidebar ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Sidebar / Settings Drawer */}
        <AnimatePresence>
          {(showSidebar || typeof window !== 'undefined' && window.innerWidth >= 768) && (
            <motion.aside 
              initial={{ x: -300 }}
              animate={{ x: 0 }}
              exit={{ x: -300 }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className={`fixed md:relative top-0 left-0 h-full w-[300px] bg-[#0a0a1a] md:bg-transparent border-r border-white/10 p-6 md:p-8 flex flex-col gap-8 z-50 md:z-10`}
            >
              <div className="hidden md:flex items-center gap-3 font-bold text-xl tracking-tight">
                <div className="w-3 h-3 bg-emerald-400 rounded-full shadow-[0_0_10px_#4ade80]" />
                LinguaFuse Live
              </div>

              <div className="space-y-6">
                <div className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-4">
                  <div className="space-y-2">
                    <span className="text-[10px] uppercase font-bold tracking-widest text-emerald-400 block">My Side</span>
                    <select 
                      value={sourceLang.code}
                      onChange={(e) => setSourceLang(LANGUAGES.find(l => l.code === e.target.value) || LANGUAGES[0])}
                      className="w-full bg-black/40 border border-white/10 rounded-lg py-2 px-3 text-xs appearance-none focus:outline-none focus:border-emerald-500/30 transition-colors cursor-pointer text-white"
                    >
                      {LANGUAGES.map(lang => (
                        <option key={lang.code} value={lang.code}>{lang.flag} {lang.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex justify-center">
                    <button 
                      onClick={switchLanguages}
                      className="p-1.5 rounded-full hover:bg-white/10 transition-colors"
                    >
                      <Languages className="w-4 h-4 text-white/40" />
                    </button>
                  </div>

                  <div className="space-y-2">
                    <span className="text-[10px] uppercase font-bold tracking-widest text-orange-400 block">Their Side</span>
                    <select 
                      value={targetLang.code}
                      onChange={(e) => setTargetLang(LANGUAGES.find(l => l.code === e.target.value) || LANGUAGES[1])}
                      className="w-full bg-black/40 border border-white/10 rounded-lg py-2 px-3 text-xs appearance-none focus:outline-none focus:border-orange-500/30 transition-colors cursor-pointer text-white"
                    >
                      {LANGUAGES.map(lang => (
                        <option key={lang.code} value={lang.code}>{lang.flag} {lang.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <button 
                  onClick={() => setAutoSpeak(!autoSpeak)}
                  className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all text-xs ${
                    autoSpeak ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-white/5 border-white/10 opacity-40'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {autoSpeak ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                    Auto Voice
                  </div>
                  <span className="text-[10px] uppercase font-bold">{autoSpeak ? 'On' : 'Off'}</span>
                </button>
              </div>

              <div className="mt-auto space-y-4">
                {/* Session Info */}
                <div className="bg-black/20 p-4 rounded-xl border border-white/5 space-y-4">
                  <div className="flex items-center justify-between text-[10px] uppercase font-bold tracking-widest text-emerald-400">
                    <span>Session Status</span>
                    {roomId ? <Check className="w-3 h-3" /> : null}
                  </div>
                  
                  {roomId ? (
                    <div className="space-y-3">
                      <div className="p-2 bg-white/5 border border-white/10 rounded flex items-center justify-between gap-2 overflow-hidden">
                        <span className="text-[10px] opacity-40 truncate">Room: {roomId}</span>
                        <button onClick={copyRoomLink} className="p-1 hover:bg-white/10 rounded text-white/60">
                          {copiedLink ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                      <button 
                        onClick={() => {
                          window.history.pushState({}, '', window.location.pathname);
                          setRoomId(null);
                          setTranscripts([]);
                          transcriptIdsRef.current.clear();
                        }}
                        className="w-full text-center text-[10px] text-red-400 hover:text-red-300 transition-colors uppercase font-bold tracking-widest"
                      >
                        Leave Session
                      </button>
                    </div>
                  ) : (
                    <button 
                      onClick={createRoom}
                      className="w-full flex items-center justify-center gap-2 p-2 bg-emerald-500/20 border border-emerald-500/40 rounded text-[10px] text-emerald-400 font-bold uppercase tracking-widest hover:bg-emerald-500 hover:text-white transition-all"
                    >
                      <Share2 className="w-3 h-3" />
                      Live Sync Room
                    </button>
                  )}
                </div>

                {/* User Info */}
                <div className="bg-black/20 p-4 rounded-xl border border-white/5 space-y-3">
                  {user ? (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {user.photoURL ? (
                          <img src={user.photoURL} referrerPolicy="no-referrer" className="w-5 h-5 rounded-full border border-white/10" alt="Avatar" />
                        ) : (
                          <UserIcon className="w-4 h-4 text-white/40" />
                        )}
                        <span className="text-[10px] text-white/60 font-medium truncate max-w-[100px]">{user.displayName}</span>
                      </div>
                      <button onClick={handleSignOut} className="p-1 text-white/20 hover:text-red-400 transition-colors">
                        <LogOut className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <button 
                      onClick={handleSignIn}
                      className="w-full flex items-center justify-center gap-2 p-2 bg-white/5 border border-white/10 rounded text-[10px] text-white/60 font-bold uppercase tracking-widest hover:bg-white/10 transition-all"
                    >
                      <LogIn className="w-3 h-3" />
                      Sign In to Sync
                    </button>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-[8px] uppercase opacity-20 tracking-wider">
                    <span>Neural Link</span>
                    <Check className="w-2 h-2" />
                  </div>
                </div>
              </div>
              
              {/* Close Button Mobile */}
              <button 
                onClick={() => setShowSidebar(false)}
                className="md:hidden mt-4 p-3 bg-white/5 rounded-xl text-center text-[10px] uppercase font-bold tracking-[0.2em] text-white/40"
              >
                Close Settings
              </button>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Backdrop for mobile drawer */}
        {showSidebar && (
          <div 
            className="md:hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
            onClick={() => setShowSidebar(false)}
          />
        )}

        {/* Main Panel */}
        <main className="flex flex-col h-full p-4 md:p-10 relative overflow-hidden">
          <header className="flex flex-col md:flex-row md:justify-between items-start gap-4 mb-6 md:mb-10 z-10">
            <div>
              <h1 className="text-lg md:text-2xl font-bold tracking-tight bg-gradient-to-r from-emerald-400 to-emerald-200 bg-clip-text text-transparent">Live Interpretation</h1>
              <div className="flex items-center gap-2 text-[9px] md:text-[10px] uppercase tracking-widest text-white/40 mt-1">
                <div className={`w-1.5 h-1.5 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-emerald-400'}`} />
                {statusMessage}
              </div>
            </div>
            <div className="hidden sm:flex flex-col items-end gap-1">
               <div className="bg-black/30 border border-white/10 px-4 py-1.5 rounded-full text-[10px] text-white/50 tracking-widest flex items-center gap-2 transition-all">
                  <Activity className="w-3 h-3" />
                  {isListening ? "SIGNAL DETECTED" : "SYSTEM READY"}
               </div>
               <span className="text-[9px] opacity-10 mr-4">SECURE AES-256 SESSION</span>
            </div>
          </header>

          {/* Transcript Scroll Area */}
          <div className="flex-1 overflow-y-auto pr-2 md:pr-4 space-y-6 scrollbar-hide z-10 pb-20 md:pb-4">
            <AnimatePresence initial={false}>
              {transcripts.map((item) => {
                const isMe = item.speakerId === user?.uid || (item.sourceLang === sourceLang.code && !roomId);
                
                // Parse AI Metadata if present
                let displayTranslation = item.translated;
                let detectedInfo = null;
                if (item.translated.includes('): ')) {
                  const parts = item.translated.split('): ');
                  detectedInfo = parts[0].replace(/\[|\]/g, '').trim();
                  displayTranslation = parts.slice(1).join('): ');
                }

                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, scale: 0.95, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    className={`flex flex-col max-w-[95%] sm:max-w-[85%] ${isMe ? 'items-start self-start' : 'items-end self-end ml-auto'}`}
                  >
                    <div className={`px-4 py-4 md:px-6 md:py-5 rounded-3xl border transition-all duration-500 ${
                      isMe 
                      ? 'bg-emerald-500/[0.03] border-emerald-500/20 rounded-bl-sm' 
                      : 'bg-orange-500/[0.03] border-orange-500/20 rounded-br-sm'
                    }`}>
                      <div className="text-[9px] md:text-[10px] font-bold uppercase tracking-widest mb-3 flex items-center gap-3">
                        <span className={isMe ? 'text-emerald-400' : 'text-orange-400'}>
                          {LANGUAGES.find(l => l.code === item.sourceLang)?.name} → {LANGUAGES.find(l => l.code === item.targetLang)?.name}
                        </span>
                        
                        {detectedInfo && (
                          <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[8px] text-white/40">
                            {detectedInfo}
                          </span>
                        )}

                        <button onClick={() => speakText(displayTranslation, item.targetLang)} className="opacity-30 hover:opacity-100 transition-opacity p-1">
                          <Volume2 className="w-3 h-3 md:w-4 md:h-4" />
                        </button>
                      </div>
                      <p className="text-sm md:text-[16px] leading-relaxed mb-4 text-white/70">{item.original}</p>
                      <div className="border-t border-white/5 pt-4">
                        <p className="text-base md:text-lg text-white font-medium leading-relaxed tracking-tight">
                          {displayTranslation}
                        </p>
                      </div>
                    </div>
                    <span className="text-[8px] md:text-[9px] text-white/20 mt-2 px-2 tracking-widest">
                      {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            
            {transcripts.length === 0 && !isListening && (
              <div className="h-full flex flex-col items-center justify-center opacity-10 py-20 pointer-events-none">
                <Globe className="w-12 h-12 md:w-20 md:h-20 mb-6" />
                <p className="text-[10px] md:text-sm uppercase tracking-[0.4em] text-center">Protocol Standby</p>
              </div>
            )}
            
            {/* Listening State Visualization */}
            {isListening && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-emerald-400/50 py-4"
              >
                <div className="flex gap-1">
                  <motion.div animate={{ height: [4, 12, 4] }} transition={{ repeat: Infinity, duration: 0.8 }} className="w-0.5 bg-emerald-500" />
                  <motion.div animate={{ height: [8, 4, 8] }} transition={{ repeat: Infinity, duration: 1.2 }} className="w-0.5 bg-emerald-500" />
                  <motion.div animate={{ height: [4, 10, 4] }} transition={{ repeat: Infinity, duration: 0.5 }} className="w-0.5 bg-emerald-500" />
                </div>
                Capturing audio sequence...
              </motion.div>
            )}
          </div>

          {/* MANUAL TEXT INPUT */}
          <div className="z-20 mb-4 px-2">
            <form onSubmit={handleManualSend} className="relative group">
              <input 
                type="text"
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder={`Type or paste ${sourceLang.name}...`}
                className="w-full bg-white/5 border border-white/10 rounded-2xl py-3.5 pl-5 pr-14 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-500/30 transition-all backdrop-blur-md"
              />
              <button 
                type="submit"
                disabled={!manualText.trim()}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-xl bg-emerald-500/10 text-emerald-400 opacity-0 group-focus-within:opacity-100 disabled:opacity-0 transition-opacity hover:bg-emerald-500 hover:text-white"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>

          {/* DUAL BIDIRECTIONAL CONTROLS */}
          <div className="mt-auto flex items-center justify-between md:justify-center gap-4 md:gap-16 bg-black/40 backdrop-blur-xl p-4 md:p-8 rounded-[32px] md:rounded-[40px] border border-white/5 relative z-20 shadow-2xl">
            
            {/* Split Indicator Line */}
            <div className="hidden md:block absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1px] h-12 bg-white/10" />

            {/* ME SIDE TRIGGER */}
            <div className="flex flex-col items-center gap-3 md:gap-4 flex-1 md:flex-none">
              <span className="text-[8px] md:text-[9px] uppercase tracking-[0.2em] text-emerald-400 font-black">Me</span>
              <div className="flex items-center gap-2 md:gap-4">
                <button
                  onClick={() => startListening('me')}
                  disabled={isListening === 'them'}
                  className={`w-12 h-12 md:w-16 md:h-16 rounded-full flex items-center justify-center transition-all duration-300 relative ${
                    isListening === 'me'
                    ? 'bg-emerald-500 scale-105 shadow-[0_0_50px_rgba(16,185,129,0.3)]' 
                    : 'bg-white/[0.03] border border-white/10 hover:bg-white/10 hover:scale-110 disabled:opacity-10'
                  }`}
                >
                  <Mic className={`w-5 h-5 md:w-7 md:h-7 ${isListening === 'me' ? 'text-black' : 'text-emerald-400'}`} />
                  
                  {isListening === 'me' && (
                    <motion.div 
                      className="absolute -inset-2 border-2 border-emerald-500 rounded-full opacity-20"
                      animate={{ scale: [1, 1.3, 1], opacity: [0.2, 0.4, 0.2] }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                    />
                  )}
                </button>

                {isListening === 'me' && (
                   <button 
                    onClick={stopListening}
                    className="w-10 h-10 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center hover:bg-red-500 transition-all text-red-500 hover:text-white"
                   >
                     <Pause className="w-4 h-4 fill-current" />
                   </button>
                )}
              </div>
              
              <div className="h-0.5 w-12 md:w-20 bg-white/5 rounded-full overflow-hidden">
                <motion.div 
                  className="h-full bg-emerald-500" 
                  animate={{ width: isListening === 'me' ? `${sensitivity}%` : '0%' }}
                />
              </div>
              <div className="text-[8px] opacity-20 uppercase font-mono">{sourceLang.code}</div>
            </div>

            {/* UTILITY BUTTONS */}
            <div className="hidden sm:flex flex-col gap-4">
               <button 
                  onClick={clearHistory}
                  disabled={transcripts.length === 0}
                  className="p-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all disabled:opacity-5 text-white/40"
                  title="Clear Log"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
            </div>

            {/* THEM SIDE TRIGGER */}
            <div className="flex flex-col items-center gap-3 md:gap-4 flex-1 md:flex-none">
              <span className="text-[8px] md:text-[9px] uppercase tracking-[0.2em] text-orange-400 font-black">Them</span>
              <div className="flex items-center gap-2 md:gap-4">
                 {isListening === 'them' && (
                   <button 
                    onClick={stopListening}
                    className="w-10 h-10 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center hover:bg-red-500 transition-all text-red-500 hover:text-white"
                   >
                     <Pause className="w-4 h-4 fill-current" />
                   </button>
                )}

                <button
                  onClick={() => startListening('them')}
                  disabled={isListening === 'me'}
                  className={`w-12 h-12 md:w-16 md:h-16 rounded-full flex items-center justify-center transition-all duration-300 relative ${
                    isListening === 'them'
                    ? 'bg-orange-500 scale-105 shadow-[0_0_50px_rgba(249,115,22,0.3)]' 
                    : 'bg-white/[0.03] border border-white/10 hover:bg-white/10 hover:scale-110 disabled:opacity-10'
                  }`}
                >
                  <Mic className={`w-5 h-5 md:w-7 md:h-7 ${isListening === 'them' ? 'text-black' : 'text-orange-400'}`} />
                  
                  {isListening === 'them' && (
                    <motion.div 
                      className="absolute -inset-2 border-2 border-orange-500 rounded-full opacity-20"
                      animate={{ scale: [1, 1.3, 1], opacity: [0.2, 0.4, 0.2] }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                    />
                  )}
                </button>
              </div>
              
              <div className="h-0.5 w-12 md:w-20 bg-white/5 rounded-full overflow-hidden">
                <motion.div 
                  className="h-full bg-orange-500" 
                  animate={{ width: isListening === 'them' ? `${sensitivity}%` : '0%' }}
                />
              </div>
              <div className="text-[8px] opacity-20 uppercase font-mono">{targetLang.code}</div>
            </div>

          </div>
        </main>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
        select option { background: #0a0a1a !important; color: white !important; }
      `}} />
    </div>
  );
}

