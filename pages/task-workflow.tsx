import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';
import EditedBadge from '../components/EditedBadge';
import { useEditedIndicator } from '../components/useEditedIndicator';
import { confirmAction, notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl, resolveBackendAssetUrl } from '@/utils/network';
import { useLiveSync } from '@/utils/liveSync';
import DocumentPreviewModal, { type PreviewDocument } from '../components/DocumentPreviewModal';

interface Task {
  id: number;
  title: string;
  description: string;
  project_name: string;
  client_name: string;
  workflow_status: string;
  status: string;
  priority: string;
  due_date: string;
  assigned_to_name: string;
  latest_file: string | null;
  latest_submission_time: string | null;
  submission_count: number;
  rejection_reason: string | null;
  created_at: string;
  started_at: string | null;
  submitted_at: string | null;
}

interface Submission {
  submission_id: number;
  task_id: number;
  submitted_by_name: string;
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type: string | null;
  notes: string;
  status: string;
  submitted_at: string;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
}

interface TaskDetails {
  task: Task;
  submissions: Submission[];
  rejections: any[];
}

export default function TaskWorkflowPage() {
  const router = useRouter();
  const API_BASE = getApiBaseUrl();
  const [tasks, setTasks] = useState<Task[]>([]);
  const { editedItems, markEdited } = useEditedIndicator();
  const [filteredTasks, setFilteredTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [userRole, setUserRole] = useState<string>('');
  const [selectedTask, setSelectedTask] = useState<number | null>(null);
  const [taskDetails, setTaskDetails] = useState<TaskDetails | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [reviewApproved, setReviewApproved] = useState(true);
  const [reviewNotes, setReviewNotes] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Task discussion / comments
  interface CommentRow {
    comment_id: number;
    task_id: number;
    user_id: number;
    parent_comment_id: number | null;
    comment_text: string | null;
    commenter_name: string;
    commenter_role: string;
    created_at: string;
  }
  const [taskComments, setTaskComments] = useState<CommentRow[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [commentSaving, setCommentSaving] = useState(false);
  const [replyTarget, setReplyTarget] = useState<CommentRow | null>(null);

  // File upload states
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadFilePreviewUrl, setUploadFilePreviewUrl] = useState<string | null>(null);
  const [uploadNotes, setUploadNotes] = useState('');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadingTaskId, setUploadingTaskId] = useState<number | null>(null);

  // Document preview modal
  const [previewDocument, setPreviewDocument] = useState<PreviewDocument | null>(null);

  // Live-sync: silently re-fetch tasks in background (no loading spinner).
  useLiveSync(async () => {
    if (!user) return;
    try {
      const response = await fetch(`${API_BASE}/task-workflow.php?action=my_tasks`, { credentials: 'include' });
      const data = await response.json();
      if (data.success) {
        setTasks(data.data.tasks);
      }
    } catch {
      // Silently ignore background refresh errors.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  useEffect(() => {
    void checkSessionAndFetch();
  }, [API_BASE, router]);

  useEffect(() => {
    applyFilters();
  }, [tasks, statusFilter]);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/task-workflow.php?action=my_tasks`, {
        credentials: 'include'
      });

      const data = await response.json();
      if (data.success) {
        setTasks(data.data.tasks);
      } else {
        showToast(data.error || data.message || 'Failed to fetch tasks', 'error');
      }
    } catch (error) {
      showToast('Error fetching tasks', 'error');
    } finally {
      setLoading(false);
    }
  };

  const checkSessionAndFetch = async () => {
    try {
      const response = await fetch(`${API_BASE}/auth.php`, { credentials: 'include' });
      const data = await response.json();
      if (!data.success) {
        router.push('/');
        return;
      }
      setUser(data.data);
      setUserRole(String(data.data?.role || '').toLowerCase());
      await fetchTasks();
    } catch {
      router.push('/');
    }
  };

  const applyFilters = () => {
    let filtered = [...tasks];

    if (statusFilter !== 'all') {
      filtered = filtered.filter(task => task.workflow_status === statusFilter);
    }

    setFilteredTasks(filtered);
  };

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    if (type === 'error') {
      void notifyError(message);
    } else {
      void notifySuccess(message);
    }
  };

  const handleStartTask = async (taskId: number) => {
    const confirmed = await confirmAction({
      title: 'Start task?',
      text: 'Are you sure you want to start this task?',
      confirmButtonText: 'Start Task',
      icon: 'question',
    });
    if (!confirmed) return;

    try {
      const response = await fetch(`${API_BASE}/task-workflow.php?action=start_task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ task_id: taskId })
      });

      const data = await response.json();
      if (data.success) {
        showToast('Task started successfully!', 'success');
        fetchTasks();
        markEdited(taskId);
      } else {
        showToast(data.error || data.message || 'Failed to start task', 'error');
      }
    } catch (error) {
      showToast('Error starting task', 'error');
    }
  };

  const handleOpenUploadModal = (taskId: number) => {
    setUploadingTaskId(taskId);
    setUploadFile(null);
    setUploadFilePreviewUrl(null);
    setUploadNotes('');
    setShowUploadModal(true);
  };

  const handleUploadFileChange = (file: File | null) => {
    if (uploadFilePreviewUrl) URL.revokeObjectURL(uploadFilePreviewUrl);
    if (file) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const isPdf = file.type === 'application/pdf' || ext === 'pdf';
      if (!isPdf) {
        void notifyError('Only PDF files are allowed. Please select a valid PDF document.');
        setUploadFile(null);
        setUploadFilePreviewUrl(null);
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        void notifyError('File size exceeds the 10 MB limit. Please choose a smaller PDF.');
        setUploadFile(null);
        setUploadFilePreviewUrl(null);
        return;
      }
    }
    setUploadFile(file);
    setUploadFilePreviewUrl(file ? URL.createObjectURL(file) : null);
  };

  const handleSubmitDocument = async () => {
    if (!uploadFile || !uploadingTaskId) {
      showToast('Please select a file', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('task_id', uploadingTaskId.toString());
    formData.append('document', uploadFile);
    formData.append('notes', uploadNotes);

    try {
      const response = await fetch(`${API_BASE}/task-workflow.php?action=submit_document`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      const data = await response.json();
      if (data.success) {
          showToast('Document submitted successfully! Waiting for manager review.', 'success');
          if (uploadFilePreviewUrl) URL.revokeObjectURL(uploadFilePreviewUrl);
          setUploadFilePreviewUrl(null);
          setShowUploadModal(false);
          fetchTasks();
          markEdited(uploadingTaskId);
      } else {
        showToast(data.error || data.message || 'Failed to submit document', 'error');
      }
    } catch (error) {
      showToast('Error submitting document', 'error');
    }
  };

  const fetchTaskComments = useCallback(async (taskId: number) => {
    setCommentsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/task-comments.php?task_id=${taskId}`, { credentials: 'include' });
      const data = await res.json();
      if (data.success) {
        setTaskComments((data.data as CommentRow[]).filter((c) => String(c.comment_text || '').trim() !== ''));
      } else {
        setTaskComments([]);
      }
    } catch {
      setTaskComments([]);
    } finally {
      setCommentsLoading(false);
    }
  }, [API_BASE]);

  const handleViewTask = async (taskId: number) => {
    try {
      const response = await fetch(`${API_BASE}/task-workflow.php?action=task_details&task_id=${taskId}`, {
        credentials: 'include'
      });

      const data = await response.json();
      if (data.success) {
        setTaskDetails(data.data);
        setSelectedTask(taskId);
        setCommentText('');
        setReplyTarget(null);
        setTaskComments([]);
        setShowModal(true);
        void fetchTaskComments(taskId);
      } else {
        showToast(data.error || data.message || 'Failed to fetch task details', 'error');
      }
    } catch (error) {
      showToast('Error fetching task details', 'error');
    }
  };

  const handleSubmitComment = async () => {
    const trimmed = commentText.trim();
    if (!trimmed || !selectedTask) return;
    setCommentSaving(true);
    try {
      const formData = new FormData();
      formData.append('task_id', String(selectedTask));
      formData.append('comment_text', trimmed);
      if (replyTarget) formData.append('parent_comment_id', String(replyTarget.comment_id));
      const res = await fetch(`${API_BASE}/task-comments.php`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const data = await res.json();
      if (data.success) {
        setCommentText('');
        setReplyTarget(null);
        void fetchTaskComments(selectedTask);
      } else {
        void notifyError(data.message || data.error || 'Failed to post comment');
      }
    } catch {
      void notifyError('Error posting comment');
    } finally {
      setCommentSaving(false);
    }
  };

  const handleOpenReviewModal = (taskId: number, approved: boolean) => {
    setSelectedTask(taskId);
    setReviewApproved(approved);
    setReviewNotes('');
    setShowReviewModal(true);
  };

  const handleSubmitReview = async () => {
    if (!selectedTask) return;

    const action = userRole === 'admin' ? 'admin_review' : 'manager_review';

    try {
      const response = await fetch(`${API_BASE}/task-workflow.php?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          task_id: selectedTask,
          approved: reviewApproved,
          review_notes: reviewNotes
        })
      });

      const data = await response.json();
      if (data.success) {
        showToast(data.data.message, 'success');
        setShowReviewModal(false);
        setShowModal(false);
        fetchTasks();
        markEdited(selectedTask);
      } else {
        showToast(data.error || data.message || 'Failed to submit review', 'error');
      }
    } catch (error) {
      showToast('Error submitting review', 'error');
    }
  };

  const getStatusBadgeClass = (status: string) => {
    const statusClasses: { [key: string]: string } = {
      'not_started': 'bg-gray-100 text-gray-800',
      'in_progress': 'bg-blue-100 text-blue-800',
      'pending_manager': 'bg-yellow-100 text-yellow-800',
      'pending_admin': 'bg-orange-100 text-orange-800',
      'rejected_by_manager': 'bg-red-100 text-red-800',
      'rejected_by_admin': 'bg-red-100 text-red-800',
      'completed': 'bg-green-100 text-green-800'
    };
    return statusClasses[status] || 'bg-gray-100 text-gray-800';
  };

  const getStatusLabel = (status: string) => {
    const labels: { [key: string]: string } = {
      'not_started': 'Not Started',
      'in_progress': 'In Progress',
      'pending_manager': 'Pending Manager Review',
      'pending_admin': 'Pending Admin Review',
      'rejected_by_manager': 'Rejected by Manager',
      'rejected_by_admin': 'Rejected by Admin',
      'completed': 'Completed'
    };
    return labels[status] || status;
  };

  const canStartTask = (task: Task) => {
    return userRole === 'staff' && task.workflow_status === 'not_started';
  };

  const canUploadDocument = (task: Task) => {
    return userRole === 'staff' &&
           (task.workflow_status === 'in_progress' ||
            task.workflow_status === 'rejected_by_manager' ||
            task.workflow_status === 'rejected_by_admin');
  };

  const canManagerReview = (task: Task) => {
    return (userRole === 'manager' || userRole === 'admin') &&
           task.workflow_status === 'pending_manager';
  };

  const canAdminReview = (task: Task) => {
    return userRole === 'admin' && task.workflow_status === 'pending_admin';
  };

  const downloadFile = (filePath: string, fileName: string) => {
    window.open(resolveBackendAssetUrl(filePath), '_blank', 'noopener,noreferrer');
  };

  const handleLogout = async () => {
    await fetch(`${API_BASE}/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
    router.push('/');
  };

  return (
    <Layout role={userRole} user={user} onLogout={handleLogout}>
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-800">Task Workflow</h1>
            <p className="text-gray-600 mt-1">Manage task submissions and approvals</p>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
          <div className="flex gap-4 items-center">
            <label className="font-medium text-gray-700">Filter by Status:</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="all">All Status</option>
              <option value="not_started">Not Started</option>
              <option value="in_progress">In Progress</option>
              <option value="pending_manager">Pending Manager Review</option>
              <option value="pending_admin">Pending Admin Review</option>
              <option value="rejected_by_manager">Rejected by Manager</option>
              <option value="rejected_by_admin">Rejected by Admin</option>
              <option value="completed">Completed</option>
            </select>

            <div className="ml-auto text-sm text-gray-600">
              Showing {filteredTasks.length} of {tasks.length} tasks
            </div>
          </div>
        </div>

        {/* Tasks List */}
        {loading ? (
          <div className="text-center py-12">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            <p className="mt-4 text-gray-600">Loading tasks...</p>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-12 text-center">
            <p className="text-gray-500 text-lg">No tasks found</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredTasks.map((task) => (
              <div key={task.id} className="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow">
                <div className="p-6">
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <h3 className="text-xl font-semibold text-gray-800 m-0 llb-ellipsis" title={task.title}>{task.title}</h3>
                        <EditedBadge editedAt={editedItems.get(task.id)} />
                      </div>
                      <p className="text-gray-600 mb-3">{task.description}</p>

                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div className="llb-ellipsis" title={task.project_name || ''}>
                          <span className="text-gray-500">Project:</span>
                          <span className="ml-2 font-medium">{task.project_name}</span>
                        </div>
                        <div className="llb-ellipsis" title={task.client_name || ''}>
                          <span className="text-gray-500">Client:</span>
                          <span className="ml-2 font-medium">{task.client_name}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Due Date:</span>
                          <span className="ml-2 font-medium">{task.due_date ? new Date(task.due_date).toLocaleDateString() : 'N/A'}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Priority:</span>
                          <span className={`ml-2 px-2 py-1 rounded text-xs font-medium ${
                            task.priority === 'high' || task.priority === 'urgent' ? 'bg-red-100 text-red-800' :
                            task.priority === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                            'bg-green-100 text-green-800'
                          }`}>
                            {task.priority?.toUpperCase() || 'N/A'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="ml-4">
                      <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusBadgeClass(task.workflow_status)}`}>
                        {getStatusLabel(task.workflow_status)}
                      </span>
                    </div>
                  </div>

                  {/* Rejection Reason */}
                  {task.rejection_reason && (
                    <div className="mb-4 p-3 bg-red-50 border-l-4 border-red-500 rounded">
                      <p className="text-sm font-medium text-red-800 mb-1">Rejection Reason:</p>
                      <p className="text-sm text-red-700">{task.rejection_reason}</p>
                    </div>
                  )}

                  {/* Latest Submission Info */}
                  {task.latest_file && (
                    <div className="mb-4 p-3 bg-blue-50 border-l-4 border-blue-500 rounded">
                      <p className="text-sm font-medium text-blue-800 mb-1">Latest Submission:</p>
                      <p className="text-sm text-blue-700">
                        {task.latest_file} - {task.latest_submission_time && new Date(task.latest_submission_time).toLocaleString()}
                      </p>
                      <p className="text-xs text-blue-600 mt-1">Total submissions: {task.submission_count}</p>
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex gap-2 pt-4 border-t border-gray-200">
                    <button
                      onClick={() => handleViewTask(task.id)}
                      className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                    >
                      View Details
                    </button>

                    {canStartTask(task) && (
                      <button
                        onClick={() => handleStartTask(task.id)}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                      >
                        Start Task
                      </button>
                    )}

                    {canUploadDocument(task) && (
                      <button
                        onClick={() => handleOpenUploadModal(task.id)}
                        className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                      >
                        {task.submission_count > 0 ? 'Upload New Document' : 'Upload Document & Done'}
                      </button>
                    )}

                    {canManagerReview(task) && (
                      <>
                        <button
                          onClick={() => handleOpenReviewModal(task.id, true)}
                          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => handleOpenReviewModal(task.id, false)}
                          className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                        >
                          Reject
                        </button>
                      </>
                    )}

                    {canAdminReview(task) && (
                      <>
                        <button
                          onClick={() => handleOpenReviewModal(task.id, true)}
                          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => handleOpenReviewModal(task.id, false)}
                          className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload Document Modal */}
      {showUploadModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.58)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ width: uploadFilePreviewUrl ? 'min(1160px, 97vw)' : 'min(520px, 97vw)', background: '#fff', borderRadius: 16, boxShadow: '0 24px 70px rgba(15,23,42,0.28)', overflow: 'hidden', display: 'grid', gridTemplateRows: 'auto 1fr auto', maxHeight: '92vh', transition: 'width 0.2s' }}>
            {/* Header */}
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#0f172a' }}>Submit Document</h2>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
                  PDF files only · Max 10 MB · A preview will appear once you select a file.
                </p>
              </div>
              <button
                onClick={() => { setShowUploadModal(false); handleUploadFileChange(null); }}
                style={{ border: '1px solid #e2e8f0', background: '#fff', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontWeight: 700, color: '#64748b', fontSize: 13, flexShrink: 0 }}
              >
                ✕ Close
              </button>
            </div>

            {/* Body — side-by-side when a PDF is loaded */}
            <div style={{ minHeight: 0, display: 'grid', gridTemplateColumns: uploadFilePreviewUrl ? '300px 1fr' : '1fr', overflow: 'hidden' }}>

              {/* Left: form controls */}
              <div style={{ overflowY: 'auto', padding: '20px 22px', borderRight: uploadFilePreviewUrl ? '1px solid #e2e8f0' : 'none', display: 'flex', flexDirection: 'column', gap: 18 }}>

                {/* Drop-zone / file picker */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    PDF File <span style={{ color: '#e53e3e' }}>*</span>
                  </label>

                  {/* Styled drop area */}
                  <label
                    htmlFor="pdf-upload-input"
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                      gap: 8, padding: '20px 14px', borderRadius: 12,
                      border: uploadFile ? '2px solid #16a34a' : '2px dashed #94a3b8',
                      background: uploadFile ? '#f0fdf4' : '#f8fafc',
                      cursor: 'pointer', textAlign: 'center', transition: 'border-color 0.15s, background 0.15s',
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const f = e.dataTransfer.files?.[0] ?? null;
                      handleUploadFileChange(f);
                      // reset the hidden input so onChange fires again if same file is re-dropped
                      const inp = document.getElementById('pdf-upload-input') as HTMLInputElement | null;
                      if (inp) inp.value = '';
                    }}
                  >
                    {uploadFile ? (
                      <>
                        {/* PDF icon */}
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                          <text x="6" y="19" fontSize="6" fill="#16a34a" stroke="none" fontWeight="700">PDF</text>
                        </svg>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#15803d', wordBreak: 'break-all', maxWidth: '100%' }}>{uploadFile.name}</span>
                        <span style={{ fontSize: 11, color: '#22c55e' }}>{(uploadFile.size / 1024).toFixed(1)} KB · Click or drop to replace</span>
                      </>
                    ) : (
                      <>
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                          <line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/>
                        </svg>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}>Click to browse or drag &amp; drop</span>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>PDF only · Max 10 MB</span>
                      </>
                    )}
                  </label>
                  <input
                    id="pdf-upload-input"
                    type="file"
                    accept=".pdf,application/pdf"
                    required
                    aria-required="true"
                    aria-label="PDF document (required)"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      handleUploadFileChange(e.target.files?.[0] ?? null);
                      e.target.value = '';   // allow re-selecting the same file
                    }}
                  />

                  {/* Clear button */}
                  {uploadFile && (
                    <button
                      type="button"
                      onClick={() => handleUploadFileChange(null)}
                      style={{ marginTop: 8, fontSize: 12, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}
                    >
                      ✕ Remove file
                    </button>
                  )}
                </div>

                {/* Notes */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Notes <span style={{ fontWeight: 400, textTransform: 'none', color: '#94a3b8' }}>(optional)</span>
                  </label>
                  <textarea
                    value={uploadNotes}
                    onChange={(e) => setUploadNotes(e.target.value)}
                    rows={6}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', color: '#0f172a', boxSizing: 'border-box' }}
                    placeholder="Add any notes for the reviewer…"
                  />
                </div>

                {/* Reminder */}
                <div style={{ padding: '10px 12px', borderRadius: 9, background: '#fffbeb', border: '1px solid #fde68a', fontSize: 12, color: '#92400e', lineHeight: 1.6 }}>
                  <strong>Reminder:</strong> Only PDF files are accepted. The document must be complete and ready for manager review before submitting.
                </div>
              </div>

              {/* Right: live PDF viewer */}
              {uploadFilePreviewUrl && (
                <div style={{ minHeight: 0, background: '#f1f5f9', padding: '12px 12px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      PDF Preview
                    </span>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>Rendered in-browser · Read-only</span>
                  </div>
                  <iframe
                    src={uploadFilePreviewUrl}
                    title="PDF preview"
                    style={{ flex: 1, width: '100%', border: '1px solid #cbd5e1', borderRadius: 10, background: '#fff', minHeight: 420 }}
                  />
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
              {!uploadFile && (
                <span style={{ fontSize: 12, color: '#94a3b8', marginRight: 'auto' }}>Select a PDF file to enable submission.</span>
              )}
              <button
                type="button"
                onClick={() => { setShowUploadModal(false); handleUploadFileChange(null); }}
                style={{ padding: '9px 18px', borderRadius: 9, border: '1px solid #e2e8f0', background: '#fff', color: '#374151', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmitDocument}
                disabled={!uploadFile}
                style={{ padding: '9px 22px', borderRadius: 9, border: 'none', background: uploadFile ? '#15803d' : '#94a3b8', color: '#fff', cursor: uploadFile ? 'pointer' : 'not-allowed', fontWeight: 800, fontSize: 13 }}
              >
                Submit Document
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Review Modal */}
      {showReviewModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-2xl font-bold text-gray-800">
                {reviewApproved ? 'Approve Task' : 'Reject Task'}
              </h2>
              <p className="text-gray-600 mt-1">
                {reviewApproved
                  ? 'Confirm approval and add optional notes'
                  : 'Please provide a reason for rejection'}
              </p>
            </div>

            <div className="p-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {reviewApproved ? 'Review Notes (Optional)' : 'Rejection Reason *'}
              </label>
              <textarea
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                rows={6}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder={reviewApproved
                  ? 'Add any comments about this approval...'
                  : 'Explain what needs to be corrected...'}
                required={!reviewApproved}
              />
            </div>

            <div className="p-6 border-t border-gray-200 flex justify-end gap-2">
              <button
                onClick={() => setShowReviewModal(false)}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitReview}
                disabled={!reviewApproved && !reviewNotes.trim()}
                className={`px-4 py-2 text-white rounded-lg transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed ${
                  reviewApproved
                    ? 'bg-green-600 hover:bg-green-700'
                    : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {reviewApproved ? 'Approve' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Details Modal */}
      {showModal && taskDetails && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200 flex justify-between items-start">
              <div>
                <h2 className="text-2xl font-bold text-gray-800">{taskDetails.task.title}</h2>
                <span className={`inline-block mt-2 px-3 py-1 rounded-full text-sm font-medium ${getStatusBadgeClass(taskDetails.task.workflow_status)}`}>
                  {getStatusLabel(taskDetails.task.workflow_status)}
                </span>
              </div>
              <button
                onClick={() => setShowModal(false)}
                className="text-gray-400 hover:text-gray-600 text-2xl font-bold"
              >
                ×
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Task Info */}
              <div>
                <h3 className="text-lg font-semibold text-gray-800 mb-3">Task Information</h3>
                <div className="grid grid-cols-2 gap-4 text-sm bg-gray-50 p-4 rounded-lg">
                  <div>
                    <span className="text-gray-600">Project:</span>
                    <p className="font-medium">{taskDetails.task.project_name}</p>
                  </div>
                  <div>
                    <span className="text-gray-600">Client:</span>
                    <p className="font-medium">{taskDetails.task.client_name}</p>
                  </div>
                  <div>
                    <span className="text-gray-600">Assigned To:</span>
                    <p className="font-medium">{taskDetails.task.assigned_to_name}</p>
                  </div>
                  <div>
                    <span className="text-gray-600">Due Date:</span>
                    <p className="font-medium">{taskDetails.task.due_date ? new Date(taskDetails.task.due_date).toLocaleDateString() : 'N/A'}</p>
                  </div>
                </div>
              </div>

              {/* Submissions History */}
              {taskDetails.submissions.length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold text-gray-800 mb-3">Submission History</h3>
                  <div className="space-y-3">
                    {taskDetails.submissions.map((submission) => {
                      const viewUrl = `${API_BASE}/task-workflow.php?action=view_submission&submission_id=${encodeURIComponent(String(submission.submission_id))}`;
                      return (
                        <div key={submission.submission_id} style={{ borderRadius: 12, border: '1px solid #e2e8f0', background: '#f8fafc', overflow: 'hidden' }}>
                          {/* Row header */}
                          <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{ fontWeight: 700, fontSize: 14, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="llb-ellipsis" title={submission.file_name}>{submission.file_name}</span>
                                <span style={{
                                  padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                                  background: submission.status === 'approved' ? '#dcfce7' : submission.status === 'rejected' ? '#fee2e2' : '#fef9c3',
                                  color:      submission.status === 'approved' ? '#15803d' : submission.status === 'rejected' ? '#b91c1c' : '#a16207',
                                }}>
                                  {submission.status.toUpperCase()}
                                </span>
                              </div>
                              <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
                                Submitted by <strong>{submission.submitted_by_name}</strong> · {new Date(submission.submitted_at).toLocaleString()}
                              </div>
                              {submission.notes && (
                                <div style={{ fontSize: 12, color: '#475569', marginTop: 4, fontStyle: 'italic' }}>"{submission.notes}"</div>
                              )}
                              {submission.reviewed_by_name && (
                                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>
                                  Reviewed by {submission.reviewed_by_name} · {submission.reviewed_at && new Date(submission.reviewed_at).toLocaleString()}
                                </div>
                              )}
                              {submission.review_notes && (
                                <div style={{ marginTop: 6, padding: '6px 10px', borderRadius: 7, background: '#fff', border: '1px solid #e2e8f0', fontSize: 12, color: '#475569' }}>
                                  <strong>Review note:</strong> {submission.review_notes}
                                </div>
                              )}
                            </div>
                            {/* Action buttons */}
                            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                              <button
                                onClick={() => setPreviewDocument({ name: submission.file_name, url: viewUrl, mime: submission.mime_type ?? null })}
                                style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1e40af', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                              >
                                👁 View File
                              </button>
                              <a
                                href={viewUrl}
                                download={submission.file_name}
                                style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', fontWeight: 700, fontSize: 12, cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                              >
                                ⬇ Download
                              </a>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Rejection History */}
              {taskDetails.rejections.length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold text-gray-800 mb-3">Rejection History</h3>
                  <div className="space-y-3">
                    {taskDetails.rejections.map((rejection, index) => (
                      <div key={index} className="bg-red-50 p-4 rounded-lg border-l-4 border-red-500">
                        <div className="flex justify-between items-start mb-2">
                          <p className="font-medium text-red-800">
                            Rejected by {rejection.rejected_by_role === 'manager' ? 'Manager' : 'Admin'}
                          </p>
                          <p className="text-sm text-red-600">
                            {new Date(rejection.rejected_at).toLocaleString()}
                          </p>
                        </div>
                        <p className="text-sm text-red-700 mb-2">
                          <strong>Reason:</strong> {rejection.reason}
                        </p>
                        {rejection.expected_corrections && (
                          <p className="text-sm text-red-600">
                            <strong>Expected Corrections:</strong> {rejection.expected_corrections}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Task Discussion ─────────────────────────────── */}
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '14px 16px', background: '#fff' }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
                  Task Discussion
                </div>

                {/* Reply banner */}
                {replyTarget && (
                  <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 8, border: '1px solid #dbeafe', background: '#eff6ff', color: '#1e3a8a', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <span>Replying to <strong>{replyTarget.commenter_name}</strong>: &quot;{String(replyTarget.comment_text || '').slice(0, 80)}{String(replyTarget.comment_text || '').length > 80 ? '…' : ''}&quot;</span>
                    <button type="button" onClick={() => setReplyTarget(null)} style={{ border: 'none', background: 'transparent', color: '#1e3a8a', cursor: 'pointer', fontWeight: 700, fontSize: 12, flexShrink: 0 }}>Clear</button>
                  </div>
                )}

                {/* Input */}
                <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
                  <textarea
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void handleSubmitComment(); }}
                    placeholder="Write a comment or reply… (Ctrl+Enter to post)"
                    rows={3}
                    required
                    aria-required="true"
                    aria-label="Comment (required)"
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', resize: 'vertical', fontSize: 13, color: '#334155', fontFamily: 'inherit', boxSizing: 'border-box' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      onClick={() => void handleSubmitComment()}
                      disabled={commentSaving || !commentText.trim()}
                      style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: commentSaving || !commentText.trim() ? '#94a3b8' : '#1e3a8a', color: '#fff', fontSize: 12, fontWeight: 700, cursor: commentSaving || !commentText.trim() ? 'not-allowed' : 'pointer', opacity: commentSaving || !commentText.trim() ? 0.75 : 1 }}
                    >
                      {commentSaving ? 'Posting…' : 'Post Comment'}
                    </button>
                  </div>
                </div>

                {/* Comment list */}
                <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
                  {commentsLoading ? (
                    <div style={{ color: '#64748b', fontSize: 13 }}>Loading comments…</div>
                  ) : taskComments.length === 0 ? (
                    <div style={{ color: '#94a3b8', fontSize: 13 }}>No comments yet. Be the first to leave one.</div>
                  ) : (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {taskComments.map((c) => {
                        const roleColor: Record<string, string> = { admin: '#7c3aed', manager: '#0369a1', staff: '#16a34a' };
                        const roleBg: Record<string, string> = { admin: '#f5f3ff', manager: '#e0f2fe', staff: '#f0fdf4' };
                        const role = (c.commenter_role || '').toLowerCase();
                        return (
                          <div
                            key={c.comment_id}
                            style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px', background: c.parent_comment_id ? '#f8fafc' : '#fff', marginLeft: c.parent_comment_id ? 20 : 0 }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                {c.parent_comment_id && (
                                  <span style={{ fontSize: 10, color: '#2563eb', fontWeight: 700, marginRight: 2 }}>↩ Reply</span>
                                )}
                                <strong style={{ color: '#0f172a', fontSize: 13 }}>{c.commenter_name || 'User'}</strong>
                                {role && (
                                  <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, color: roleColor[role] || '#64748b', background: roleBg[role] || '#f1f5f9', textTransform: 'capitalize' }}>
                                    {role}
                                  </span>
                                )}
                              </div>
                              <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                                {c.created_at ? new Date(c.created_at).toLocaleString() : ''}
                              </span>
                            </div>
                            <div style={{ color: '#334155', fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                              {c.comment_text}
                            </div>
                            <div style={{ marginTop: 6 }}>
                              <button
                                type="button"
                                onClick={() => setReplyTarget(c)}
                                style={{ border: 'none', background: 'transparent', color: '#1e3a8a', fontSize: 12, cursor: 'pointer', padding: 0, fontWeight: 700 }}
                              >
                                Reply
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              {/* ─────────────────────────────────────────────────── */}

            </div>
          </div>
        </div>
      )}

      <DocumentPreviewModal document={previewDocument} onClose={() => setPreviewDocument(null)} />
    </Layout>
  );
}
