import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import LZString from 'lz-string';
import { 
  BookOpen, 
  Clock, 
  Target, 
  Layers, 
  Search, 
  PlayCircle, 
  ChevronRight, 
  Loader2, 
  Sparkles,
  Youtube,
  ExternalLink,
  CheckCircle2,
  MessageSquare,
  RefreshCw,
  ArrowRight,
  AlertCircle,
  Share2,
  Bookmark,
  Trash2,
  Printer,
  Globe,
  Plus,
  Filter,
  User,
  LogOut,
  LogIn
} from 'lucide-react';
import { 
  generateCourseStructure, 
  findVideoForTopic, 
  summarizeVideo, 
  regenerateCourseStructure,
  checkVideoAvailability,
  Course, 
  CourseTopic 
} from './services/gemini';
import { db, auth, signInWithGoogle, signOut } from './firebase';
import AuthModal from './components/AuthModal';
import { 
  collection, 
  addDoc, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';

type AppStep = 'input' | 'generating_structure' | 'review_structure' | 'processing_topics' | 'course' | 'library' | 'global_library';

const CATEGORIES = ["Technology", "Business", "Arts & Design", "Science", "Health", "Lifestyle"];

export default function App() {
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<AppStep>('input');
  const [status, setStatus] = useState('');
  const [course, setCourse] = useState<Course | null>(() => {
    const saved = localStorage.getItem('tubecourse_current');
    return saved ? JSON.parse(saved) : null;
  });
  
  const [formData, setFormData] = useState({
    subject: '',
    goal: '',
    timeCommitment: '5 hours',
    level: 'Beginner'
  });

  const [feedback, setFeedback] = useState('');
  const [currentTopicIndex, setCurrentTopicIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [savedCourses, setSavedCourses] = useState<Course[]>(() => {
    const saved = localStorage.getItem('tubecourse_library');
    return saved ? JSON.parse(saved) : [];
  });

  const [globalCourses, setGlobalCourses] = useState<any[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [shareCategory, setShareCategory] = useState(CATEGORIES[0]);
  const [user, setUser] = useState(auth.currentUser);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [eta, setEta] = useState<number | null>(null);
  const processingRef = React.useRef(false);

  // Timer for ETA
  React.useEffect(() => {
    let timer: any;
    if (isProcessing && eta !== null && eta > 0) {
      timer = setInterval(() => {
        setEta(prev => (prev !== null && prev > 0 ? prev - 1 : 0));
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isProcessing, eta]);

  const requireAuth = (action: () => void) => {
    if (auth.currentUser) {
      action();
    } else {
      setPendingAction(() => action);
      setIsAuthModalOpen(true);
    }
  };

  React.useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((u) => {
      setUser(u);
      setIsAuthReady(true);
      if (u && pendingAction) {
        pendingAction();
        setPendingAction(null);
      }
    });
    return () => unsubscribe();
  }, [pendingAction]);

  const fetchGlobalCourses = async (category?: string) => {
    setLoading(true);
    try {
      let q = query(collection(db, 'global_courses'), orderBy('createdAt', 'desc'));
      if (category) {
        q = query(collection(db, 'global_courses'), where('category', '==', category), orderBy('createdAt', 'desc'));
      }
      const snapshot = await getDocs(q);
      const courses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setGlobalCourses(courses);
    } catch (e) {
      console.error("Error fetching global courses", e);
      setError("Failed to load global library. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    if (step === 'global_library') {
      fetchGlobalCourses(selectedCategory || undefined);
    }
  }, [step, selectedCategory]);

  // Persist course to localStorage only when fully generated
  React.useEffect(() => {
    if (course && step === 'course') {
      localStorage.setItem('tubecourse_current', JSON.stringify(course));
    }
  }, [course, step]);

  // Handle shared courses from URL
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sharedData = params.get('share');
    if (sharedData) {
      try {
        const decompressed = LZString.decompressFromEncodedURIComponent(sharedData);
        if (decompressed) {
          const sharedCourse = JSON.parse(decompressed);
          setCourse(sharedCourse);
          setStep('course');
          // Clear the URL param without reloading
          window.history.replaceState({}, '', window.location.pathname);
        }
      } catch (e) {
        console.error('Failed to load shared course', e);
      }
    }
  }, []);

  // If there's a saved course, jump to course view
  React.useEffect(() => {
    if (!isAuthReady) return;
    const saved = localStorage.getItem('tubecourse_current');
    if (saved && step === 'input' && user) {
      setStep('course');
    }
  }, [isAuthReady, user, step]);

  const toggleTopicCompletion = (index: number) => {
    if (!course) return;
    const updatedTopics = [...course.topics];
    updatedTopics[index] = {
      ...updatedTopics[index],
      completed: !updatedTopics[index].completed
    };
    setCourse({ ...course, topics: updatedTopics });
  };

  const progress = course 
    ? Math.round((course.topics.filter(t => t.completed).length / course.topics.length) * 100)
    : 0;

  const handleGenerateStructure = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    
    requireAuth(async () => {
      setLoading(true);
      setStep('generating_structure');
      setError(null);
      
      try {
        setStatus('Designing your curriculum...');
        const structure = await generateCourseStructure(formData);
        setCourse(structure);
        setStep('review_structure');
      } catch (err: any) {
        console.error(err);
        setError(err.message || 'An unexpected error occurred.');
        setStep('input');
      } finally {
        setLoading(false);
      }
    });
  };

  const handleRegenerate = async () => {
    if (!course) return;
    setLoading(true);
    setError(null);
    setStatus('Updating curriculum based on your feedback...');
    
    try {
      const structure = await regenerateCourseStructure(formData, course, feedback);
      setCourse(structure);
      setFeedback('');
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to regenerate course.');
    } finally {
      setLoading(false);
    }
  };

  const startProcessing = () => {
    setCurrentTopicIndex(0);
    setStep('processing_topics');
    if (course) {
      // Estimate 15 seconds per topic
      setEta(course.topics.length * 15);
    }
  };

  const processTopic = async (index: number) => {
    if (!course) return;
    setLoading(true);
    setError(null);
    setIsProcessing(true);
    processingRef.current = true;
    
    try {
      const updatedTopics = [...course.topics];
      const topic = updatedTopics[index];
      
      setStatus(`Searching for a working video for "${topic.title}"...`);
      let video = await findVideoForTopic(topic);
      
      // Pre-check video existence
      let isValid = await checkVideoAvailability(video.url);
      let attempts = 0;
      
      while (!isValid && attempts < 2 && processingRef.current) {
        attempts++;
        setStatus(`Video found was unavailable. Retrying search (Attempt ${attempts + 1})...`);
        video = await findVideoForTopic(topic);
        isValid = await checkVideoAvailability(video.url);
      }

      if (!processingRef.current) {
        setLoading(false);
        setIsProcessing(false);
        return;
      }
      
      if (isValid && video.url && video.url.includes('youtube.com/watch?v=')) {
        updatedTopics[index].videoUrl = video.url;
        updatedTopics[index].videoTitle = video.title;
        
        setStatus(`Summarizing video for "${topic.title}"...`);
        const summary = await summarizeVideo(video.url, topic.title);
        
        if (!processingRef.current) {
          setLoading(false);
          setIsProcessing(false);
          return;
        }
        
        updatedTopics[index].videoSummary = summary;
      } else {
        // Handle case where no valid video is found
        updatedTopics[index].videoUrl = undefined;
        updatedTopics[index].videoSummary = "Could not find a valid educational video for this topic after multiple attempts. Please try searching manually or try another video.";
      }
      
      setCourse({ ...course, topics: updatedTopics });
    } catch (err: any) {
      console.error(err);
      if (processingRef.current) {
        setError(`Failed to process topic "${course.topics[index].title}": ${err.message}`);
      }
    } finally {
      setLoading(false);
      setIsProcessing(false);
      processingRef.current = false;
    }
  };

  const stopProcessing = () => {
    processingRef.current = false;
    setIsProcessing(false);
    setLoading(false);
    setStatus('Stopped.');
    setEta(null);
  };

  const handleNextTopic = () => {
    if (!course) return;
    if (currentTopicIndex + 1 < course.topics.length) {
      const remaining = course.topics.length - (currentTopicIndex + 1);
      setEta(remaining * 15); // Reset estimate for remaining topics
      setCurrentTopicIndex(currentTopicIndex + 1);
    } else {
      setEta(null);
      setStep('course');
    }
  };

  const generationProgress = course 
    ? Math.round((course.topics.filter(t => t.videoUrl || t.videoSummary).length / course.topics.length) * 100)
    : 0;

  const cleanMarkdown = (text: string) => {
    // Remove escaped asterisks if they exist (sometimes models do this)
    return text.replace(/\\\*/g, '*').replace(/\\_/g, '_');
  };

  const saveToLibrary = () => {
    if (!course) return;
    const exists = savedCourses.some(c => c.title === course.title);
    if (!exists) {
      const updated = [course, ...savedCourses];
      setSavedCourses(updated);
      localStorage.setItem('tubecourse_library', JSON.stringify(updated));
    }
  };

  const deleteFromLibrary = (title: string) => {
    const updated = savedCourses.filter(c => c.title !== title);
    setSavedCourses(updated);
    localStorage.setItem('tubecourse_library', JSON.stringify(updated));
  };

  const shareCourse = () => {
    if (!course) return;
    const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(course));
    const shareUrl = `${window.location.origin}${window.location.pathname}?share=${compressed}`;
    navigator.clipboard.writeText(shareUrl);
    alert('Share link copied to clipboard!');
  };

  const handlePrint = () => {
    window.print();
  };

  const handleShareToGlobal = async () => {
    if (!course) return;
    if (!user) {
      setIsAuthModalOpen(true);
      return;
    }
    
    setIsSharing(true);
  };

  const confirmShareToGlobal = async () => {
    if (!course || !user) return;
    setLoading(true);
    try {
      await addDoc(collection(db, 'global_courses'), {
        title: course.title,
        description: course.introduction || "",
        category: shareCategory,
        topics: course.topics.map(t => ({
          title: t.title,
          videoUrl: t.videoUrl || null,
          videoSummary: t.videoSummary || null,
          completed: false
        })),
        authorId: user.uid,
        authorName: user.displayName || "Anonymous",
        createdAt: serverTimestamp()
      });
      setIsSharing(false);
      setStep('global_library');
    } catch (e) {
      console.error("Error sharing to global library", e);
      setError("Failed to share course. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <Loader2 className="animate-spin text-emerald-600" size={48} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f5f5] text-zinc-900 font-sans selection:bg-emerald-100 selection:text-emerald-900">
      <header className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-md border-b border-zinc-200 px-6 py-4 print:hidden">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div 
            className="flex items-center gap-2 cursor-pointer"
            onClick={() => setStep('input')}
          >
            <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center text-white">
              <Sparkles size={18} />
            </div>
            <span className="font-bold text-xl tracking-tight">TubeCourse AI</span>
          </div>

          <div className="flex items-center gap-4">
            <button 
              onClick={() => setStep('global_library')}
              className={`px-4 py-2 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
                step === 'global_library' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              <Globe size={18} />
              Global Library
            </button>
            <button 
              onClick={() => setStep('library')}
              className={`px-4 py-2 rounded-xl font-bold text-sm transition-all flex items-center gap-2 ${
                step === 'library' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              <Bookmark size={18} />
              My Library
            </button>
            <button 
              onClick={() => {
                localStorage.removeItem('tubecourse_current');
                setCourse(null);
                setStep('input');
                setCurrentTopicIndex(0);
              }}
              className="text-sm font-medium text-zinc-500 hover:text-zinc-900 transition-colors"
            >
              New Course
            </button>

            <div className="h-6 w-px bg-zinc-200 mx-2"></div>

            {user ? (
              <div className="flex items-center gap-3">
                <div className="flex flex-col items-end">
                  <span className="text-sm font-bold text-zinc-900">{user.displayName || user.email}</span>
                  <button 
                    onClick={() => signOut(auth)}
                    className="text-[10px] font-bold text-zinc-400 hover:text-red-500 uppercase tracking-widest transition-colors"
                  >
                    Sign Out
                  </button>
                </div>
                <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center text-emerald-700 font-bold border-2 border-white shadow-sm">
                  {user.displayName ? user.displayName[0].toUpperCase() : <User size={20} />}
                </div>
              </div>
            ) : (
              <button 
                onClick={() => setIsAuthModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-xl font-bold text-sm hover:bg-emerald-600 transition-all"
              >
                <LogIn size={18} />
                Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="pt-24 pb-12 px-6">
        <AnimatePresence mode="wait">
          {step === 'global_library' && (
            <motion.div 
              key="global_library"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-6xl mx-auto"
            >
              <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6">
                <div>
                  <h1 className="text-4xl font-black mb-4 tracking-tight">Global Library</h1>
                  <p className="text-zinc-500 text-lg">Discover courses created by the community.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button 
                    onClick={() => setSelectedCategory(null)}
                    className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                      selectedCategory === null ? 'bg-zinc-900 text-white' : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                    }`}
                  >
                    All
                  </button>
                  {CATEGORIES.map(cat => (
                    <button 
                      key={cat}
                      onClick={() => setSelectedCategory(cat)}
                      className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                        selectedCategory === cat ? 'bg-zinc-900 text-white' : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {loading && globalCourses.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24">
                  <Loader2 className="animate-spin text-emerald-600 mb-4" size={48} />
                  <p className="text-zinc-500 font-medium">Loading courses...</p>
                </div>
              ) : globalCourses.length === 0 ? (
                <div className="text-center py-24 bg-white rounded-3xl border border-zinc-200 border-dashed">
                  <Globe size={48} className="mx-auto text-zinc-300 mb-4" />
                  <h3 className="text-xl font-bold text-zinc-400">No courses found</h3>
                  <p className="text-zinc-400 mb-8">Be the first to share a course in this category!</p>
                  <button 
                    onClick={() => setStep('input')}
                    className="bg-zinc-900 text-white px-8 py-3 rounded-xl font-bold hover:bg-emerald-600 transition-all"
                  >
                    Create a Course
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {globalCourses.map((c) => (
                    <div key={c.id} className="bg-white rounded-3xl border border-zinc-200 p-8 hover:border-emerald-500 transition-all group flex flex-col">
                      <div className="flex justify-between items-start mb-4">
                        <span className="px-3 py-1 bg-emerald-100 text-emerald-700 text-[10px] font-bold uppercase tracking-widest rounded-full">
                          {c.category}
                        </span>
                        <div className="text-zinc-400">
                          <BookOpen size={20} />
                        </div>
                      </div>
                      <h3 className="text-xl font-bold mb-2 group-hover:text-emerald-600 transition-colors line-clamp-2">{c.title}</h3>
                      <p className="text-zinc-500 text-sm line-clamp-3 mb-6 flex-1">{c.description || "No description provided."}</p>
                      
                      <div className="flex items-center gap-3 mb-6 pt-4 border-t border-zinc-50">
                        <div className="w-8 h-8 bg-zinc-100 rounded-full flex items-center justify-center text-zinc-500">
                          <User size={16} />
                        </div>
                        <div className="text-xs">
                          <p className="font-bold text-zinc-900">{c.authorName}</p>
                          <p className="text-zinc-400">{c.createdAt?.toDate ? c.createdAt.toDate().toLocaleDateString() : 'Recently'}</p>
                        </div>
                      </div>

                      <button 
                        onClick={() => {
                          requireAuth(() => {
                            const courseData: Course = {
                              title: c.title,
                              introduction: c.description,
                              topics: c.topics
                            };
                            setCourse(courseData);
                            setStep('course');
                          });
                        }}
                        className="w-full bg-zinc-900 text-white py-3 rounded-xl font-bold hover:bg-emerald-600 transition-all"
                      >
                        Learn Now
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {step === 'library' && (
            <motion.div 
              key="library"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-4xl mx-auto"
            >
              <div className="mb-12">
                <h1 className="text-4xl font-black mb-4 tracking-tight">My Library</h1>
                <p className="text-zinc-500">All your generated courses in one place.</p>
              </div>

              {savedCourses.length === 0 ? (
                <div className="text-center py-24 bg-white rounded-3xl border border-zinc-200 border-dashed">
                  <Bookmark size={48} className="mx-auto text-zinc-300 mb-4" />
                  <h3 className="text-xl font-bold text-zinc-400">Your library is empty</h3>
                  <p className="text-zinc-400 mb-8">Generate your first course to see it here.</p>
                  <button 
                    onClick={() => setStep('input')}
                    className="bg-zinc-900 text-white px-8 py-3 rounded-xl font-bold hover:bg-emerald-600 transition-all"
                  >
                    Start Learning
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {savedCourses.map((c, i) => (
                    <div key={i} className="bg-white rounded-3xl border border-zinc-200 p-8 hover:border-emerald-500 transition-all group relative">
                      <div className="flex justify-between items-start mb-4">
                        <div className="w-12 h-12 bg-emerald-100 rounded-xl flex items-center justify-center text-emerald-600">
                          <BookOpen size={24} />
                        </div>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteFromLibrary(c.title);
                          }}
                          className="text-zinc-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={20} />
                        </button>
                      </div>
                      <h3 className="text-xl font-bold mb-2 group-hover:text-emerald-600 transition-colors">{c.title}</h3>
                      <p className="text-zinc-500 text-sm line-clamp-2 mb-6">{c.topics.length} Topics • {c.topics.filter(t => t.completed).length} Completed</p>
                      <button 
                        onClick={() => {
                          requireAuth(() => {
                            setCourse(c);
                            setStep('course');
                          });
                        }}
                        className="w-full bg-zinc-100 text-zinc-900 py-3 rounded-xl font-bold hover:bg-zinc-900 hover:text-white transition-all"
                      >
                        Open Course
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          )}
          {step === 'input' && (
            <motion.div 
              key="input"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="max-w-2xl mx-auto"
            >
              <div className="text-center mb-12">
                <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
                  What do you want to <span className="text-emerald-600">master</span> today?
                </h1>
                <p className="text-zinc-500 text-lg">
                  Tell us your goals, and we'll curate a custom learning path using the best of YouTube.
                </p>
              </div>

              {error && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mb-8 p-4 bg-red-50 border border-red-100 rounded-2xl text-red-600 text-sm flex items-start gap-3"
                >
                  <AlertCircle size={18} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-bold mb-1">Generation Failed</p>
                    <p className="opacity-90">{error}</p>
                  </div>
                </motion.div>
              )}

              <form onSubmit={handleGenerateStructure} className="bg-white p-8 rounded-3xl shadow-sm border border-zinc-200 space-y-6">
                <div className="space-y-2">
                  <label className="text-sm font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                    <BookOpen size={14} /> Subject
                  </label>
                  <input 
                    required
                    type="text"
                    placeholder="e.g. Quantum Physics, Italian Cooking, React Development"
                    className="w-full px-4 py-3 rounded-xl border border-zinc-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    value={formData.subject}
                    onChange={e => setFormData({ ...formData, subject: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                    <Target size={14} /> Your Goal
                  </label>
                  <textarea 
                    required
                    placeholder="What do you want to achieve? e.g. Build a portfolio project, understand the basics for an exam..."
                    className="w-full px-4 py-3 rounded-xl border border-zinc-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all min-h-[100px]"
                    value={formData.goal}
                    onChange={e => setFormData({ ...formData, goal: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                      <Clock size={14} /> Time Commitment
                    </label>
                    <select 
                      className="w-full px-4 py-3 rounded-xl border border-zinc-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all bg-white"
                      value={formData.timeCommitment}
                      onChange={e => setFormData({ ...formData, timeCommitment: e.target.value })}
                    >
                      <option>1 hour (Crash Course)</option>
                      <option>5 hours (Deep Dive)</option>
                      <option>10 hours (Comprehensive)</option>
                      <option>20+ hours (Mastery)</option>
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                      <Layers size={14} /> Current Level
                    </label>
                    <select 
                      className="w-full px-4 py-3 rounded-xl border border-zinc-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all bg-white"
                      value={formData.level}
                      onChange={e => setFormData({ ...formData, level: e.target.value })}
                    >
                      <option>Beginner</option>
                      <option>Intermediate</option>
                      <option>Advanced</option>
                    </select>
                  </div>
                </div>

                <button 
                  type="submit"
                  disabled={loading}
                  className="w-full bg-zinc-900 text-white py-4 rounded-xl font-bold text-lg hover:bg-emerald-600 transition-all flex items-center justify-center gap-2 group"
                >
                  {loading ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <>
                      Design Curriculum
                      <ChevronRight size={20} className="group-hover:translate-x-1 transition-transform" />
                    </>
                  )}
                </button>
              </form>

              {/* About the Creator Section */}
              <div className="mt-24 pt-12 border-t border-zinc-200">
                <h2 className="text-2xl font-bold mb-8 text-center">About the Creator</h2>
                <div className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-sm flex flex-col md:flex-row gap-8 items-center">
                  <div className="flex-1">
                    <h3 className="text-xl font-bold mb-4 text-emerald-600">Ambuj Mishra</h3>
                    <p className="text-zinc-600 leading-relaxed mb-6">
                      Hi, I’m Ambuj Mishra — a Product Manager in the tech industry with a strong interest in AI, product innovation, and learning systems. I build tools that simplify complex workflows and help people learn faster using modern technologies like generative AI.
                    </p>
                    <p className="text-zinc-500 text-sm font-medium">
                      Follow me on LinkedIn for updates and new product experiments.
                    </p>
                  </div>
                  <div className="shrink-0">
                    <div 
                      className="badge-base LI-profile-badge" 
                      data-locale="en_US" 
                      data-size="large" 
                      data-theme="dark" 
                      data-type="HORIZONTAL" 
                      data-vanity="ambujmishra1" 
                      data-version="v1"
                    >
                      <a 
                        className="badge-base__link LI-simple-link" 
                        href="https://in.linkedin.com/in/ambujmishra1?trk=profile-badge"
                      >
                        Ambuj Mishra
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {step === 'generating_structure' && (
            <motion.div 
              key="generating_structure"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="max-w-md mx-auto text-center py-24"
            >
              <div className="relative w-24 h-24 mx-auto mb-8">
                <div className="absolute inset-0 border-4 border-emerald-100 rounded-full"></div>
                <div className="absolute inset-0 border-4 border-emerald-600 rounded-full border-t-transparent animate-spin"></div>
                <div className="absolute inset-0 flex items-center justify-center text-emerald-600">
                  <Sparkles size={32} />
                </div>
              </div>
              <h2 className="text-2xl font-bold mb-2">Designing your curriculum...</h2>
              <p className="text-zinc-500 animate-pulse">{status}</p>
            </motion.div>
          )}

          {step === 'review_structure' && course && (
            <motion.div 
              key="review_structure"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-3xl mx-auto"
            >
              <div className="mb-8">
                <h1 className="text-3xl font-bold mb-2 tracking-tight">Review Your Curriculum</h1>
                <p className="text-zinc-500">We've designed this path for you. Feel free to request changes or proceed to find the best videos.</p>
              </div>

              <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden mb-8">
                <div className="p-8 border-b border-zinc-100 bg-zinc-50/50">
                  <h2 className="text-2xl font-black mb-2">{course.title}</h2>
                  <div className="text-zinc-600 prose prose-sm prose-zinc max-w-none">
                    <Markdown>{cleanMarkdown(course.introduction)}</Markdown>
                  </div>
                </div>
                <div className="p-8 space-y-6">
                  {course.topics.map((topic, idx) => (
                    <div key={idx} className="flex gap-4 items-start">
                      <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center text-sm font-bold shrink-0">
                        {idx + 1}
                      </div>
                      <div>
                        <h3 className="font-bold text-lg">{topic.title}</h3>
                        <p className="text-zinc-500 text-sm">{topic.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-emerald-50 border border-emerald-100 rounded-3xl p-8 mb-8">
                <div className="flex items-center gap-2 mb-4 text-emerald-700 font-bold">
                  <MessageSquare size={18} />
                  <span>Request Changes</span>
                </div>
                <div className="flex gap-3">
                  <input 
                    type="text"
                    placeholder="e.g. Add more focus on advanced topics, or remove the third topic..."
                    className="flex-1 px-4 py-3 rounded-xl border border-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all bg-white"
                    value={feedback}
                    onChange={e => setFeedback(e.target.value)}
                  />
                  <button 
                    onClick={handleRegenerate}
                    disabled={loading || !feedback.trim()}
                    className="bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-700 transition-all disabled:opacity-50 flex items-center gap-2"
                  >
                    {loading ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
                    Regenerate
                  </button>
                </div>
              </div>

              <div className="flex justify-between items-center">
                <button 
                  onClick={() => setStep('input')}
                  className="text-zinc-500 font-bold hover:text-zinc-900 transition-colors flex items-center gap-2"
                >
                  <ChevronRight size={20} className="rotate-180" />
                  Back to Settings
                </button>
                <button 
                  onClick={startProcessing}
                  className="bg-zinc-900 text-white px-8 py-4 rounded-xl font-bold text-lg hover:bg-emerald-600 transition-all flex items-center gap-2 group"
                >
                  Approve & Find Videos
                  <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
                </button>
              </div>
            </motion.div>
          )}

          {step === 'processing_topics' && course && (
            <motion.div 
              key="processing_topics"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="max-w-2xl mx-auto py-12"
            >
              <div className="text-center mb-12">
                <h2 className="text-3xl font-bold mb-4">Building Your Course</h2>
                <p className="text-zinc-500">We're finding the best educational videos for each topic.</p>
              </div>

              <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm p-8 mb-8">
                <div className="mb-8">
                  <div className="flex justify-between text-sm font-bold mb-2">
                    <span className="text-zinc-400 uppercase tracking-widest">Overall Progress</span>
                    <div className="flex items-center gap-4">
                      {eta !== null && eta > 0 && (
                        <span className="text-zinc-400 font-medium flex items-center gap-1">
                          <Clock size={14} />
                          Est. {Math.floor(eta / 60)}m {eta % 60}s remaining
                        </span>
                      )}
                      <span className="text-emerald-600">{generationProgress}%</span>
                    </div>
                  </div>
                  <div className="h-3 bg-zinc-100 rounded-full overflow-hidden">
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${generationProgress}%` }}
                      className="h-full bg-emerald-500"
                    />
                  </div>
                </div>

                <div className="space-y-6">
                  {course.topics.map((topic, idx) => {
                    const isCurrent = idx === currentTopicIndex;
                    const isDone = topic.videoUrl !== undefined || topic.videoSummary !== undefined;
                    
                    return (
                      <div 
                        key={idx} 
                        className={`p-4 rounded-2xl border transition-all ${
                          isCurrent ? 'border-emerald-500 bg-emerald-50/50 ring-2 ring-emerald-500/10' : 
                          isDone ? 'border-zinc-100 bg-zinc-50/50 opacity-60' : 
                          'border-zinc-100 opacity-40'
                        }`}
                      >
                        <div className="flex flex-col gap-4">
                          <div className="flex items-center justify-between gap-4">
                            <div className="flex items-center gap-4">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                                isDone ? 'bg-emerald-100 text-emerald-600' : 
                                isCurrent ? 'bg-emerald-600 text-white' : 
                                'bg-zinc-100 text-zinc-400'
                              }`}>
                                {isDone ? <CheckCircle2 size={16} /> : idx + 1}
                              </div>
                              <span className={`font-bold ${isCurrent ? 'text-emerald-900' : 'text-zinc-600'}`}>
                                {topic.title}
                              </span>
                            </div>
                            
                            {isCurrent && !isDone && !loading && (
                              <button 
                                onClick={() => processTopic(idx)}
                                className="bg-zinc-900 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-600 transition-all flex items-center gap-2"
                              >
                                Find Video & Summary <ChevronRight size={14} />
                              </button>
                            )}

                            {isCurrent && isDone && !loading && (
                              <div className="flex gap-2">
                                <button 
                                  onClick={() => processTopic(idx)}
                                  className="text-zinc-500 px-4 py-2 rounded-lg text-sm font-bold hover:bg-zinc-100 transition-all flex items-center gap-2"
                                  title="Try to find a different video if this one is broken"
                                >
                                  <RefreshCw size={14} /> Try Another Video
                                </button>
                                <button 
                                  onClick={handleNextTopic}
                                  className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-700 transition-all flex items-center gap-2"
                                >
                                  {idx + 1 === course.topics.length ? 'Finish Course' : 'Next Topic'} <ArrowRight size={14} />
                                </button>
                              </div>
                            )}

                            {isCurrent && loading && (
                              <div className="flex items-center gap-4">
                                <div className="flex items-center gap-2 text-emerald-600 text-sm font-bold">
                                  <Loader2 size={16} className="animate-spin" />
                                  Processing...
                                </div>
                                <button 
                                  onClick={stopProcessing}
                                  className="text-red-500 hover:text-red-700 text-xs font-bold flex items-center gap-1 px-2 py-1 rounded border border-red-100 hover:bg-red-50 transition-all"
                                >
                                  <RefreshCw size={12} className="rotate-45" /> Stop
                                </button>
                              </div>
                            )}
                          </div>

                          {isDone && (
                            <motion.div 
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              className="pl-12 space-y-4"
                            >
                              {topic.videoUrl ? (
                                <div className="flex items-center gap-4 p-3 bg-zinc-50 rounded-xl border border-zinc-100">
                                  <div className="w-20 aspect-video bg-zinc-200 rounded-lg overflow-hidden shrink-0">
                                    <img 
                                      src={`https://img.youtube.com/vi/${topic.videoUrl.split('v=')[1]}/hqdefault.jpg`} 
                                      alt={topic.videoTitle}
                                      className="w-full h-full object-cover"
                                      referrerPolicy="no-referrer"
                                    />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="font-bold text-sm truncate">{topic.videoTitle}</p>
                                    <a href={topic.videoUrl} target="_blank" rel="noreferrer" className="text-xs text-emerald-600 hover:underline flex items-center gap-1">
                                      View on YouTube <ExternalLink size={10} />
                                    </a>
                                  </div>
                                </div>
                              ) : (
                                <div className="p-3 bg-red-50 border border-red-100 rounded-xl text-red-600 text-xs flex items-center gap-2">
                                  <AlertCircle size={14} />
                                  No video found for this topic.
                                </div>
                              )}
                              <div className="text-sm text-zinc-600 prose prose-sm prose-zinc max-w-none">
                                <Markdown>{cleanMarkdown(topic.videoSummary || '')}</Markdown>
                              </div>
                            </motion.div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {error && (
                <div className="p-4 bg-red-50 border border-red-100 rounded-2xl text-red-600 text-sm flex items-start gap-3 mb-8">
                  <AlertCircle size={18} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-bold mb-1">Processing Error</p>
                    <p className="opacity-90">{error}</p>
                    <button 
                      onClick={() => processTopic(currentTopicIndex)}
                      className="mt-2 text-red-700 font-bold underline hover:no-underline"
                    >
                      Try Again
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {step === 'course' && course && (
            <motion.div 
              key="course"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="max-w-5xl mx-auto"
            >
              <div className="mb-12">
                <div className="flex items-center gap-3 mb-4">
                  <span className="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold uppercase tracking-widest">
                    Course Generated
                  </span>
                  <span className="text-zinc-400 text-sm">•</span>
                  <span className="text-zinc-500 text-sm flex items-center gap-1">
                    <Clock size={14} /> {formData.timeCommitment}
                  </span>
                </div>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 print:hidden">
                  <h1 className="text-4xl md:text-6xl font-black tracking-tight leading-tight flex-1">
                    {course.title}
                  </h1>
                  <div className="flex items-center gap-3 shrink-0">
                    <button 
                      onClick={shareCourse}
                      className="flex items-center gap-2 px-4 py-2 bg-white border border-zinc-200 rounded-xl font-bold text-sm hover:bg-zinc-50 transition-all"
                    >
                      <Share2 size={18} />
                      Share
                    </button>
                    <button 
                      onClick={handleShareToGlobal}
                      className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl font-bold text-sm hover:bg-emerald-700 transition-all"
                    >
                      <Globe size={18} />
                      Publish to Global
                    </button>
                    <button 
                      onClick={saveToLibrary}
                      className={`flex items-center gap-2 px-4 py-2 border rounded-xl font-bold text-sm transition-all ${
                        savedCourses.some(c => c.title === course.title)
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                          : 'bg-white border-zinc-200 text-zinc-900 hover:bg-zinc-50'
                      }`}
                    >
                      <Bookmark size={18} />
                      {savedCourses.some(c => c.title === course.title) ? 'Saved' : 'Save to Library'}
                    </button>
                  </div>
                </div>
                <div className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-sm mb-12">
                  <h3 className="text-sm font-bold uppercase tracking-widest text-zinc-400 mb-4">Introduction</h3>
                  <div className="text-lg text-zinc-600 leading-relaxed prose prose-zinc max-w-none">
                    <Markdown>{course.introduction}</Markdown>
                  </div>
                </div>
              </div>

              <div className="space-y-8">
                {course.topics.map((topic, index) => (
                  <motion.div 
                    key={index}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.1 }}
                    className="group relative grid grid-cols-1 lg:grid-cols-[80px_1fr] gap-6"
                  >
                    <div className="hidden lg:flex flex-col items-center">
                      <div className="w-12 h-12 rounded-full bg-zinc-900 text-white flex items-center justify-center font-bold text-xl mb-4">
                        {index + 1}
                      </div>
                      <div className="w-px flex-1 bg-zinc-200"></div>
                    </div>

                    <div className={`bg-white rounded-3xl border ${topic.completed ? 'border-emerald-200 bg-emerald-50/30' : 'border-zinc-200'} shadow-sm overflow-hidden hover:shadow-md transition-all`}>
                      <div className="p-8">
                        <div className="flex flex-col md:flex-row md:items-start justify-between gap-6 mb-8">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2">
                              <h2 className={`text-2xl font-bold flex items-center gap-3 ${topic.completed ? 'text-emerald-900' : ''}`}>
                                <span className={`lg:hidden w-8 h-8 rounded-full flex items-center justify-center text-sm ${topic.completed ? 'bg-emerald-600 text-white' : 'bg-zinc-900 text-white'}`}>
                                  {index + 1}
                                </span>
                                {topic.title}
                              </h2>
                              {topic.completed && (
                                <span className="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider">
                                  Completed
                                </span>
                              )}
                            </div>
                            <p className="text-zinc-500 leading-relaxed">
                              {topic.description}
                            </p>
                          </div>
                          
                          <div className="flex flex-col gap-2">
                            {topic.videoUrl ? (
                              <a 
                                href={topic.videoUrl} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 bg-red-50 text-red-600 px-4 py-2 rounded-xl font-bold text-sm hover:bg-red-600 hover:text-white transition-all whitespace-nowrap"
                              >
                                <Youtube size={18} />
                                Watch Video
                                <ExternalLink size={14} />
                              </a>
                            ) : (
                              <div className="flex items-center gap-2 text-zinc-400 px-4 py-2 bg-zinc-50 rounded-xl text-sm font-medium">
                                <AlertCircle size={16} />
                                No Video Found
                              </div>
                            )}
                            
                            {topic.videoUrl && (
                              <button
                                onClick={() => toggleTopicCompletion(index)}
                                className={`flex items-center justify-center gap-2 px-4 py-2 rounded-xl font-bold text-sm transition-all ${
                                  topic.completed 
                                    ? 'bg-emerald-600 text-white' 
                                    : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                                }`}
                              >
                                <CheckCircle2 size={18} />
                                {topic.completed ? 'Completed' : 'Mark as Done'}
                              </button>
                            )}
                          </div>
                        </div>

                        {topic.videoUrl && (
                          <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-8 mt-8 pt-8 border-t border-zinc-100">
                            <div className="relative group/video rounded-2xl overflow-hidden aspect-video bg-zinc-100 flex items-center justify-center">
                              <img 
                                src={`https://img.youtube.com/vi/${topic.videoUrl.split('v=')[1]}/hqdefault.jpg`} 
                                alt={topic.videoTitle}
                                className="w-full h-full object-cover opacity-80 group-hover/video:scale-105 transition-transform"
                                referrerPolicy="no-referrer"
                              />
                              <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                                <PlayCircle size={48} className="text-white drop-shadow-lg" />
                              </div>
                            </div>
                            
                            <div className="space-y-4">
                              <div className="flex items-center gap-2 text-emerald-600 font-bold text-xs uppercase tracking-widest">
                                <CheckCircle2 size={14} /> AI Summary
                              </div>
                              {topic.videoSummary ? (
                                <div className="text-zinc-600 leading-relaxed prose prose-sm prose-zinc max-w-none">
                                  <Markdown>{cleanMarkdown(topic.videoSummary || '')}</Markdown>
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  <div className="h-4 bg-zinc-100 rounded w-full animate-pulse"></div>
                                  <div className="h-4 bg-zinc-100 rounded w-3/4 animate-pulse"></div>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {!topic.videoUrl && topic.videoSummary && (
                           <div className="mt-8 pt-8 border-t border-zinc-100">
                             <div className="flex items-center gap-2 text-zinc-400 font-bold text-xs uppercase tracking-widest mb-4">
                               <AlertCircle size={14} /> Note
                             </div>
                             <p className="text-zinc-500 text-sm italic">{topic.videoSummary}</p>
                           </div>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>

              <div className="mt-24 text-center pb-24">
                <div className="inline-flex flex-col items-center">
                  <div className="w-16 h-16 bg-emerald-600 rounded-full flex items-center justify-center text-white mb-6">
                    <CheckCircle2 size={32} />
                  </div>
                  <h2 className="text-3xl font-bold mb-4">You're all set!</h2>
                  <p className="text-zinc-500 max-w-md mx-auto mb-8">
                    This course was custom-built for your goals. Happy learning!
                  </p>
                  <div className="flex items-center gap-4 print:hidden">
                    <button 
                      onClick={handlePrint}
                      className="flex items-center gap-2 px-8 py-3 bg-zinc-900 text-white rounded-xl font-bold hover:bg-emerald-600 transition-all shadow-lg shadow-zinc-200"
                    >
                      <Printer size={20} />
                      Save as PDF
                    </button>
                    <button 
                      onClick={shareCourse}
                      className="flex items-center gap-2 px-8 py-3 bg-white border border-zinc-200 rounded-xl font-bold hover:bg-zinc-50 transition-all"
                    >
                      <Share2 size={20} />
                      Share Link
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {isAuthModalOpen && (
          <AuthModal 
            isOpen={isAuthModalOpen} 
            onClose={() => setIsAuthModalOpen(false)} 
          />
        )}
        {isSharing && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-zinc-900/60 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl"
            >
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h3 className="text-2xl font-bold mb-1">Publish to Global</h3>
                  <p className="text-zinc-500 text-sm">Share your course with the community.</p>
                </div>
                <button 
                  onClick={() => setIsSharing(false)}
                  className="text-zinc-400 hover:text-zinc-900 transition-colors"
                >
                  <RefreshCw size={24} className="rotate-45" />
                </button>
              </div>

              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-bold text-zinc-400 uppercase tracking-widest mb-3">
                    Select Category
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {CATEGORIES.map(cat => (
                      <button 
                        key={cat}
                        onClick={() => setShareCategory(cat)}
                        className={`px-4 py-3 rounded-xl text-sm font-bold transition-all text-left border ${
                          shareCategory === cat 
                            ? 'bg-emerald-50 border-emerald-500 text-emerald-700' 
                            : 'bg-white border-zinc-200 text-zinc-600 hover:border-zinc-300'
                        }`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-zinc-50 p-4 rounded-2xl border border-zinc-100">
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    By publishing, your course title, topics, and author name will be visible to all TubeCourse AI users.
                  </p>
                </div>

                <button 
                  onClick={confirmShareToGlobal}
                  disabled={loading}
                  className="w-full bg-zinc-900 text-white py-4 rounded-xl font-bold hover:bg-emerald-600 transition-all flex items-center justify-center gap-2"
                >
                  {loading ? <Loader2 className="animate-spin" /> : <Globe size={20} />}
                  {loading ? 'Publishing...' : 'Confirm & Publish'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
