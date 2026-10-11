import { useState, useEffect } from 'react';

/**
 * DescriptionCell Component
 * 
 * Displays description/reason text in a table cell with:
 * - Single line display with ellipsis for long text
 * - "See more..." button for text longer than threshold
 * - Floating modal popup to show full text when clicked
 * 
 * @example
 * <DescriptionCell
 *   text={row.description}
 *   title="Description"
 *   recordId={row.id}
 *   charLimit={50}
 * />
 */

interface DescriptionCellProps {
  text: string;
  title?: string;
  recordId?: number | string;
  charLimit?: number;
  showLabel?: boolean;
  labelText?: string;
  fontSize?: number;
  color?: string;
}

export default function DescriptionCell({
  text,
  title = 'Description',
  recordId,
  charLimit = 50,
  showLabel = false,
  labelText = '',
  fontSize = 12,
  color = '#334155',
}: DescriptionCellProps) {
  const [showModal, setShowModal] = useState(false);
  const displayText = text || '-';
  const isLong = displayText.length > charLimit;

  useEffect(() => {
    if (!showModal) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowModal(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showModal]);

  const modalTitle = recordId 
    ? `${title} - Record #${recordId}`
    : title;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {showLabel && labelText && (
          <strong style={{ fontSize: fontSize - 1, color: '#64748b' }}>
            {labelText}
          </strong>
        )}
        <div style={{ 
          flex: 1,
          whiteSpace: 'nowrap', 
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          lineHeight: 1.5,
          fontSize,
          color
        }}>
          {displayText}
        </div>
        {isLong && (
          <button
            type="button"
            onClick={() => setShowModal(true)}
            style={{
              background: 'none',
              border: 'none',
              color: '#2563eb',
              cursor: 'pointer',
              fontSize: fontSize - 1,
              fontWeight: 600,
              padding: 0,
              textDecoration: 'underline',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            See more...
          </button>
        )}
      </div>

      {showModal && (
        <div 
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1300,
            padding: 16
          }} 
          onClick={() => setShowModal(false)}
        >
          <div 
            style={{
              background: '#fff',
              borderRadius: 12,
              maxWidth: 600,
              width: '90%',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.3)'
            }} 
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid #e5e7eb'
            }}>
              <h2 style={{ 
                margin: 0, 
                fontSize: 14, 
                color: '#1f2937', 
                fontWeight: 700 
              }}>
                {modalTitle}
              </h2>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: 20,
                  cursor: 'pointer',
                  color: '#9ca3af',
                  lineHeight: 1,
                  padding: 0,
                  width: 24,
                  height: 24,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                aria-label="Close description modal"
              >
                ×
              </button>
            </div>
            
            {/* Content */}
            <div style={{ 
              padding: '16px 20px',
              overflowY: 'auto',
              fontSize: 13,
              lineHeight: 1.6,
              color: '#374151',
              whiteSpace: 'pre-wrap',
              wordWrap: 'break-word'
            }}>
              {displayText}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Usage Examples:
 * 
 * 1. Basic usage in a table cell:
 * <td style={tdStyle}>
 *   <DescriptionCell 
 *     text={row.reason} 
 *     title="Reason"
 *     recordId={row.id}
 *   />
 * </td>
 * 
 * 2. With custom char limit:
 * <DescriptionCell 
 *   text={row.description} 
 *   title="Description"
 *   charLimit={80}
 * />
 * 
 * 3. With label (like "Note:"):
 * <DescriptionCell 
 *   text={row.manager_notes} 
 *   title="Manager Notes"
 *   recordId={row.id}
 *   showLabel={true}
 *   labelText="Note:"
 *   fontSize={11}
 *   color="#64748b"
 * />
 * 
 * 4. Multiple descriptions in same cell:
 * <td style={tdStyle}>
 *   <div style={{ display: 'grid', gap: 8 }}>
 *     <DescriptionCell text={row.reason} title="Reason" />
 *     {row.notes && (
 *       <DescriptionCell 
 *         text={row.notes} 
 *         title="Notes"
 *         showLabel={true}
 *         labelText="Note:"
 *         fontSize={11}
 *       />
 *     )}
 *   </div>
 * </td>
 */
