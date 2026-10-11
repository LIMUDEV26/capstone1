export type ReportExportFormat = 'csv' | 'excel' | 'json' | 'txt' | 'html' | 'pdf' | 'png' | 'print';

export type ReportThemeInfo = {
  gradient: string;
  accent: string;
  tagline: string;
  palette?: string[];
};

export type ReportMetricItem = {
  label: string;
  value: string | number;
  hint?: string;
  tone?: string;
};

export type ReportTableColumn = {
  key: string;
  label: string;
};

export type ReportMetricsSection = {
  type: 'metrics';
  title: string;
  description?: string;
  items: ReportMetricItem[];
};

export type ReportTableSection = {
  type: 'table';
  title: string;
  description?: string;
  columns: ReportTableColumn[];
  rows: Array<Record<string, string | number | null>>;
};

export type ReportSection = ReportMetricsSection | ReportTableSection;

export type ReportPayload = {
  report_key: string;
  title: string;
  description: string;
  generated_at: string;
  theme?: ReportThemeInfo;
  filters?: {
    date_from?: string | null;
    date_to?: string | null;
    branch_id?: number | null;
    branch_label?: string | null;
    scope_note?: string | null;
    role?: string | null;
  };
  sections: ReportSection[];
};

export type ReportDefinition = {
  key: string;
  title: string;
  description: string;
};

function escapeCsv(value: unknown) {
  const stringValue = String(value ?? '');
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

/**
 * Convert a UI display string into a real Excel number when possible.
 *
 * The backend pre-formats figures ("1,234", "PHP 1,234.50", "12.5%"), which
 * Excel imports as TEXT when quoted — breaking sums and matching vs the UI.
 * Returns the plain numeric cell (unquoted) or null when not numeric.
 */
function toExcelNumericCell(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  const text = String(value ?? '').trim();
  const match = text.match(/^(PHP\s+)?(-?[\d,]*\.?\d+)(%)?$/i);
  if (!match || !/\d/.test(match[2])) return null;
  const digits = match[2].replace(/,/g, '');
  if (digits === '' || Number.isNaN(Number(digits))) return null;
  return digits + (match[3] ?? '');
}

function csvCell(value: unknown) {
  return toExcelNumericCell(value) ?? escapeCsv(value);
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeFileSegment(value: string) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function resolveReportFileBaseName(report: ReportPayload) {
  const reportPart = normalizeFileSegment(report.report_key || report.title || 'report');
  const branchPart = normalizeFileSegment(report.filters?.branch_label || 'all-branches');
  const dateFrom = normalizeFileSegment(report.filters?.date_from || 'all-time');
  const dateTo = normalizeFileSegment(report.filters?.date_to || 'all-time');
  return `${reportPart}_${branchPart}_${dateFrom}_${dateTo}`.replace(/-+/g, '-');
}

function resolveCollectionFileBaseName(reports: ReportPayload[]) {
  if (reports.length === 0) return 'all_reports';
  const first = reports[0];
  const branchPart = normalizeFileSegment(first.filters?.branch_label || 'all-branches');
  const dateFrom = normalizeFileSegment(first.filters?.date_from || 'all-time');
  const dateTo = normalizeFileSegment(first.filters?.date_to || 'all-time');
  return `all_reports_${branchPart}_${dateFrom}_${dateTo}`.replace(/-+/g, '-');
}

function downloadTextFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function buildFilterSummary(report: ReportPayload) {
  const parts: string[] = [];
  if (report.filters?.branch_label) {
    parts.push(`Branch scope: ${report.filters.branch_label}`);
  }
  if (report.filters?.date_from || report.filters?.date_to) {
    parts.push(
      `Date range: ${report.filters?.date_from || 'Beginning'} to ${report.filters?.date_to || 'Present'}`
    );
  } else {
    parts.push('Date range: All time');
  }
  if (report.filters?.scope_note) {
    parts.push(String(report.filters.scope_note));
  }
  return parts;
}

function buildReportText(report: ReportPayload) {
  const lines: string[] = [];
  lines.push(report.title);
  lines.push(report.description);
  lines.push(`Generated at: ${report.generated_at}`);
  for (const summary of buildFilterSummary(report)) {
    lines.push(summary);
  }
  lines.push('');

  for (const section of report.sections) {
    lines.push(section.title);
    if (section.description) {
      lines.push(section.description);
    }
    if (section.type === 'metrics') {
      section.items.forEach((item) => {
        lines.push(`${item.label}: ${item.value}`);
        if (item.hint) {
          lines.push(`  ${item.hint}`);
        }
      });
    } else {
      lines.push(section.columns.map((column) => column.label).join(' | '));
      section.rows.forEach((row) => {
        lines.push(section.columns.map((column) => String(row[column.key] ?? '')).join(' | '));
      });
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildReportCsv(report: ReportPayload) {
  const lines: string[] = [];
  lines.push(escapeCsv(report.title));
  lines.push(escapeCsv(report.description));
  lines.push(escapeCsv(`Generated at: ${report.generated_at}`));
  buildFilterSummary(report).forEach((summary) => {
    lines.push(escapeCsv(summary));
  });
  lines.push('');

  report.sections.forEach((section) => {
    lines.push(escapeCsv(section.title));
    if (section.description) {
      lines.push(escapeCsv(section.description));
    }

    if (section.type === 'metrics') {
      lines.push('Metric,Value,Hint');
      section.items.forEach((item) => {
        lines.push([escapeCsv(item.label), csvCell(item.value), escapeCsv(item.hint || '')].join(','));
      });
    } else {
      lines.push(section.columns.map((column) => escapeCsv(column.label)).join(','));
      section.rows.forEach((row) => {
        lines.push(section.columns.map((column) => csvCell(row[column.key] ?? '')).join(','));
      });
    }

    lines.push('');
  });

  return lines.join('\n');
}

const DEFAULT_EXPORT_ACCENT = '#075f66';

function resolveExportAccent(report: ReportPayload) {
  const accent = String(report.theme?.accent || '').trim();
  return /^#[0-9a-f]{6}$/i.test(accent) ? accent : DEFAULT_EXPORT_ACCENT;
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const num = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  if (Number.isNaN(num)) return [30, 58, 138];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/**
 * Styled Excel workbook (.xls) that mirrors the on-screen report: themed
 * title banner, KPI cards, insight strip, and fully styled tables. Figures
 * are written with x:num so they stay summable in Excel instead of text.
 *
 * NOTE: every visual is an INLINE style — Excel largely ignores <style>
 * classes when importing HTML, so classes alone render as the plain grid
 * from the screenshot. Inline styles are what Excel actually honors.
 */
function buildReportExcelDocument(title: string, reports: ReportPayload[]) {
  const F = 'font-family: Arial, Helvetica, sans-serif;';
  const excelCell = (value: unknown, fontSize: string, bold: boolean, color: string, bg = '') => {
    const numeric = toExcelNumericCell(value);
    const style = `${F}font-size: ${fontSize}; font-weight: ${bold ? 'bold' : 'normal'}; color: ${color};${bg ? ` background: ${bg};` : ''}`;
    if (numeric !== null) {
      const display = escapeHtml(String(value ?? ''));
      return `<td style="${style}" x:num="${numeric}">${display}</td>`;
    }
    return `<td style="${style}">${escapeHtml(value)}</td>`;
  };

  const body = reports
    .map((report) => {
      const accent = resolveExportAccent(report);
      const tagline = report.theme?.tagline || '';
      const whiteOn = `color: #ffffff; background: ${accent};`;
      const filterItems = buildFilterSummary(report)
        .map((summary) => `<tr><td style="${F}font-size: 9pt; color: #475569;" colspan="8">${escapeHtml(summary)}</td></tr>`)
        .join('');
      const sections = report.sections
        .map((section) => {
          const head = `<tr><td colspan="8"></td></tr>
            <tr><td style="${F}font-size: 13pt; font-weight: bold; color: #0f172a;" colspan="8">${escapeHtml(section.title)}</td></tr>
            ${section.description ? `<tr><td style="${F}font-size: 9pt; color: #64748b;" colspan="8">${escapeHtml(section.description)}</td></tr>` : ''}`;
          if (section.type === 'metrics') {
            const cardRows: string[] = [];
            for (let index = 0; index < section.items.length; index += 2) {
              const pair = section.items.slice(index, index + 2);
              while (pair.length < 2) pair.push({ label: '', value: '', hint: '' });
              const labelRow = pair.map((item) => `<td style="${F}font-size: 9pt; font-weight: bold; color: #527078; background: #f8fbfb; border: 1px solid #dbe3e8;" colspan="4">${escapeHtml(item.label)}</td>`).join('');
              const valueRow = pair.map((item) => {
                const numeric = toExcelNumericCell(item.value);
                const numberAttribute = numeric !== null ? ` x:num="${numeric}"` : '';
                return `<td style="${F}font-size: 16pt; font-weight: bold; color: #244f59; background: #ffffff; border-left: 1px solid #dbe3e8; border-right: 1px solid #dbe3e8;" colspan="4"${numberAttribute}>${escapeHtml(item.value)}</td>`;
              }).join('');
              const hintRow = pair.map((item) => `<td style="${F}font-size: 8pt; color: #789098; background: #ffffff; border: 1px solid #dbe3e8;" colspan="4">${escapeHtml(item.hint || '')}</td>`).join('');
              cardRows.push(`<tr>${labelRow}</tr><tr>${valueRow}</tr><tr>${hintRow}</tr><tr><td colspan="8"></td></tr>`);
            }
            const cards = cardRows.join('');
            return `${head}${cards}`;
          }
          const colCount = Math.max(section.columns.length, 1);
          const header = `<tr>${section.columns.map((column) => `<td style="${F}font-size: 10pt; font-weight: bold; color: #ffffff; background: ${accent};">${escapeHtml(column.label)}</td>`).join('')}${colCount < 8 ? `<td colspan="${8 - colCount}"></td>` : ''}</tr>`;
          const rows =
            section.rows.length > 0
              ? section.rows
                  .map((row, rowIndex) => {
                    const bg = rowIndex % 2 === 1 ? '#f8fafc' : '';
                    const cells = section.columns
                      .map((column) => excelCell(row[column.key] ?? '', '10pt', false, '#0f172a', bg))
                      .join('');
                    return `<tr>${cells}${colCount < 8 ? `<td colspan="${8 - colCount}"></td>` : ''}</tr>`;
                  })
                  .join('')
              : `<tr><td style="${F}font-size: 10pt; color: #0f172a;" colspan="8">No data available.</td></tr>`;
          return `${head}${header}${rows}`;
        })
        .join('');

      return `<table border="1" cellspacing="0" cellpadding="6">
        <tr><td style="${F}font-size: 20pt; font-weight: bold; ${whiteOn}" colspan="8">${escapeHtml(report.title)}</td></tr>
        ${tagline ? `<tr><td style="${F}font-size: 10pt; ${whiteOn}" colspan="8">${escapeHtml(tagline)}</td></tr>` : ''}
        <tr><td style="${F}font-size: 9pt; color: #475569;" colspan="8">${escapeHtml(report.description)}</td></tr>
        <tr><td style="${F}font-size: 9pt; color: #475569;" colspan="8">Generated at: ${escapeHtml(report.generated_at)}</td></tr>
        ${filterItems}
        ${sections}
        <tr><td colspan="8"></td></tr>
      </table><br/>`;
    })
    .join('');

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
</head>
<body>${body}</body>
</html>`;
}

function buildReportHtmlDocument(title: string, reports: ReportPayload[]) {
  const body = reports
    .map((report) => {
      const sections = report.sections
        .map((section) => {
          if (section.type === 'metrics') {
            const cards = section.items
              .map(
                (item) => `
                  <div class="metric-card tone-${escapeHtml(item.tone || 'neutral')}">
                    <div class="metric-label">${escapeHtml(item.label)}</div>
                    <div class="metric-value">${escapeHtml(item.value)}</div>
                    <div class="metric-hint">${escapeHtml(item.hint || '')}</div>
                  </div>
                `
              )
              .join('');

            return `
              <section class="report-section">
                <h3>${escapeHtml(section.title)}</h3>
                ${section.description ? `<p class="section-description">${escapeHtml(section.description)}</p>` : ''}
                <div class="metric-grid">${cards}</div>
              </section>
            `;
          }

          const header = section.columns
            .map((column) => `<th>${escapeHtml(column.label)}</th>`)
            .join('');
          const rows = section.rows
            .map((row) => {
              const cells = section.columns
                .map((column) => `<td>${escapeHtml(row[column.key] ?? '')}</td>`)
                .join('');
              return `<tr>${cells}</tr>`;
            })
            .join('');

          return `
            <section class="report-section">
              <h3>${escapeHtml(section.title)}</h3>
              ${section.description ? `<p class="section-description">${escapeHtml(section.description)}</p>` : ''}
              <div class="table-wrap">
                <table>
                  <thead><tr>${header}</tr></thead>
                  <tbody>${rows || `<tr><td colspan="${section.columns.length}">No data available.</td></tr>`}</tbody>
                </table>
              </div>
            </section>
          `;
        })
        .join('');

      const filters = buildFilterSummary(report)
        .map((summary) => `<li>${escapeHtml(summary)}</li>`)
        .join('');
      const theme = report.theme;
      const heroStyle = theme?.gradient
        ? `background: ${escapeHtml(theme.gradient)}; border: none; padding: 20px 22px; border-radius: 14px;`
        : '';

      return `
        <article class="report-shell">
          <header class="report-header"${heroStyle ? ` style="${heroStyle}"` : ''}>
            <p class="report-eyebrow"${heroStyle ? ' style="color: rgba(255,255,255,0.72);"' : ''}>${escapeHtml(theme?.tagline || report.report_key)}</p>
            <h2${heroStyle ? ' style="color: #ffffff;"' : ''}>${escapeHtml(report.title)}</h2>
            <p class="report-description"${heroStyle ? ' style="color: rgba(255,255,255,0.86);"' : ''}>${escapeHtml(report.description)}</p>
            <p class="report-generated"${heroStyle ? ' style="color: rgba(255,255,255,0.72);"' : ''}>Generated at: ${escapeHtml(report.generated_at)}</p>
            <ul class="filter-list"${heroStyle ? ' style="color: rgba(255,255,255,0.86);"' : ''}>${filters}</ul>
          </header>
          ${sections}
        </article>
      `;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      font-family: Arial, Helvetica, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      margin: 0;
      padding: 32px;
    }
    .report-shell {
      background: #ffffff;
      border: 1px solid #dbe4f0;
      border-radius: 18px;
      padding: 24px;
      margin: 0 0 28px;
      box-shadow: 0 12px 24px rgba(15, 23, 42, 0.08);
      page-break-inside: avoid;
    }
    .report-eyebrow {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #2563eb;
      font-weight: 700;
      margin: 0 0 8px;
    }
    .report-header h2 {
      margin: 0 0 8px;
      font-size: 28px;
    }
    .report-description,
    .report-generated,
    .section-description,
    .metric-hint,
    .filter-list {
      color: #475569;
    }
    .filter-list {
      margin: 12px 0 0;
      padding-left: 18px;
    }
    .report-section {
      margin-top: 22px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .metric-card {
      border-radius: 14px;
      padding: 14px;
      border: 1px solid #dbe4f0;
      background: #f8fafc;
    }
    .metric-card.tone-good {
      background: #ecfdf5;
      border-color: #a7f3d0;
    }
    .metric-card.tone-warn {
      background: #fff7ed;
      border-color: #fdba74;
    }
    .metric-card.tone-danger {
      background: #fef2f2;
      border-color: #fca5a5;
    }
    .metric-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #64748b;
      margin-bottom: 8px;
    }
    .metric-value {
      font-size: 26px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 6px;
    }
    .table-wrap {
      overflow: hidden;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #ffffff;
    }
    th,
    td {
      padding: 10px 12px;
      border-bottom: 1px solid #e2e8f0;
      text-align: left;
      vertical-align: top;
      font-size: 13px;
    }
    th {
      background: #f8fafc;
      color: #475569;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    @media print {
      body {
        background: #ffffff;
        padding: 0;
      }
      .report-shell {
        border: none;
        box-shadow: none;
        padding: 0 0 18px;
        margin: 0 0 28px;
      }
    }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

/**
 * Build the same compact analytics composition used by the Reports screen.
 * This is deliberately separate from the data-first HTML builder above: the
 * latter remains useful as a semantic fallback, while this document is the
 * visual source used by HTML, Print and PDF exports.
 */
function buildScreenMatchedReportHtmlDocument(title: string, reports: ReportPayload[]) {
  const previewLimit = 4;

  const metricNumber = (value: string | number) => {
    const match = String(value ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return match ? Math.abs(Number(match[0])) : 0;
  };

  const renderPreview = (section: ReportTableSection) => {
    const [primary, ...others] = section.columns;
    const rows = section.rows.slice(0, previewLimit).map((row, index) => {
      const rowTitle = primary ? row[primary.key] : `Row ${index + 1}`;
      const detail = others.slice(0, 2)
        .map((column) => `${column.label}: ${String(row[column.key] ?? '')}`)
        .join(' | ');
      const badges = others.slice(2, 5)
        .map((column) => `<span class="preview-badge">${escapeHtml(column.label)}: ${escapeHtml(row[column.key] ?? '')}</span>`)
        .join('');
      return `<div class="preview-row">
        <div class="preview-title">${escapeHtml(rowTitle ?? '')}</div>
        ${detail ? `<div class="preview-detail">${escapeHtml(detail)}</div>` : ''}
        ${badges ? `<div class="preview-badges">${badges}</div>` : ''}
      </div>`;
    }).join('');
    return `${rows || '<div class="empty-mini">No rows available for this section.</div>'}
      ${section.rows.length > previewLimit ? `<div class="preview-meta">Showing ${previewLimit} of ${section.rows.length} rows</div>` : ''}`;
  };

  const renderReport = (report: ReportPayload) => {
    const metricSections = report.sections.filter((section): section is ReportMetricsSection => section.type === 'metrics');
    const insightSection = metricSections.find((section) => section.title.toLowerCase() === 'key insights');
    const featuredMetrics = metricSections.find((section) => section !== insightSection)?.items || [];
    const tables = report.sections.filter((section): section is ReportTableSection => section.type === 'table');
    const chartMetrics = featuredMetrics.filter((item) => metricNumber(item.value) > 0).slice(0, 5);
    const rankedMetrics = (chartMetrics.length ? chartMetrics : featuredMetrics).slice(0, 6);
    const palette = report.theme?.palette?.length
      ? report.theme.palette
      : ['#2563eb', '#14b8a6', '#8b5cf6', '#f59e0b', '#ef4444', '#0ea5e9'];
    const total = chartMetrics.reduce((sum, item) => sum + metricNumber(item.value), 0) || 1;
    let donutCursor = 0;
    const donutSegments = chartMetrics.map((item, index) => {
      const percent = (metricNumber(item.value) / total) * 100;
      const segment = `<circle cx="50" cy="50" r="38" pathLength="100" fill="none" stroke="${palette[index % palette.length]}" stroke-width="20" stroke-dasharray="${percent.toFixed(3)} ${(100 - percent).toFixed(3)}" stroke-dashoffset="${(-donutCursor).toFixed(3)}" />`;
      donutCursor += percent;
      return segment;
    }).join('');
    const maxRank = Math.max(...rankedMetrics.map((item) => metricNumber(item.value)), 1);
    const filters = buildFilterSummary(report);

    const insights = insightSection?.items.map((item) => `<div class="insight-card">
      <span class="insight-dot" style="background:${escapeHtml(report.theme?.accent || '#2563eb')}"></span>
      <div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.value)}</span></div>
    </div>`).join('') || '';

    const gaugeColors = ['#c8db72', '#f4b665', '#ef7078'];
    const largestMetric = Math.max(...featuredMetrics.map((item) => metricNumber(item.value)), 1);
    const kpis = featuredMetrics.slice(0, 3).map((item, index) => {
      const numericValue = metricNumber(item.value);
      const isPercent = String(item.value ?? '').includes('%');
      const gaugeValue = Math.max(0, Math.min(100, isPercent ? numericValue : (numericValue / largestMetric) * 100));
      return `<div class="gauge-item">
        <span class="kpi-label">${escapeHtml(item.label)}</span>
        <div class="metric-gauge" style="--gauge-value:${(gaugeValue * 2.7).toFixed(2)}deg;--gauge-color:${gaugeColors[index % gaugeColors.length]}">
          <div class="metric-gauge-center"><strong class="kpi-value">${escapeHtml(item.value)}</strong></div>
        </div>
        ${item.hint ? `<span class="kpi-hint">${escapeHtml(item.hint)}</span>` : ''}
      </div>`;
    }).join('');

    const legend = chartMetrics.map((item, index) => `<div class="legend-row">
      <span class="legend-swatch" style="background:${palette[index % palette.length]}"></span>
      <div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.value)}</span></div>
    </div>`).join('');

    const ranking = rankedMetrics.map((item, index) => {
      const width = Math.max(4, (metricNumber(item.value) / maxRank) * 100);
      return `<div class="rank-row"><span>${escapeHtml(item.label)}</span><div class="rank-track"><i style="width:${width.toFixed(2)}%;background:${palette[index % palette.length]}"></i></div><strong>${escapeHtml(item.value)}</strong></div>`;
    }).join('');

    return `<article class="report-page">
      <header class="analytics-header">
        <div>
          <span class="eyebrow">Analytics dashboard</span>
          <h1>${escapeHtml(report.title)}</h1>
          <p>${escapeHtml(report.description)}</p>
        </div>
        <div class="analytics-meta">
          <span>Scope: ${escapeHtml(filters.join(' | '))}</span>
          <span>Generated ${escapeHtml(report.generated_at)}</span>
        </div>
      </header>
      <div class="dashboard-grid">
        ${kpis ? `<section class="panel overview-panel"><header><div><span class="eyebrow">${escapeHtml(metricSections.find((section) => section !== insightSection)?.title || 'Overview')}</span><h2>Performance overview</h2></div></header><div class="gauge-grid">${kpis}</div></section>` : ''}
        ${insights ? `<section class="panel insight-panel"><header><div><span class="eyebrow">Data signals</span><h2>Key insights</h2></div></header><div class="insight-list">${insights}</div></section>` : ''}
        <section class="panel">
          <header><div><span class="eyebrow">${escapeHtml(metricSections.find((section) => section !== insightSection)?.title || 'Metric mix')}</span><h2>Distribution overview</h2></div></header>
          ${chartMetrics.length ? `<div class="spotlight"><div class="donut"><svg viewBox="0 0 100 100" role="img" aria-label="Metric distribution"><g transform="rotate(-90 50 50)">${donutSegments}</g></svg></div><div class="legend-list">${legend}</div></div>` : '<div class="empty-mini">No chart-ready metrics are available for this analytics view.</div>'}
        </section>
        ${rankedMetrics.length > 1 ? `<section class="panel"><header><div><span class="eyebrow">Performance</span><h2>Metric ranking</h2></div></header><div class="rank-list">${ranking}</div></section>` : ''}
        ${tables[0] ? `<section class="panel"><header><div><span class="eyebrow">${escapeHtml(tables[0].title)}</span><h2>Detailed analytics</h2></div></header><div class="preview-list">${renderPreview(tables[0])}</div></section>` : '<div class="empty-mini">No detailed analytics are available for this view.</div>'}
        ${tables[1] ? `<section class="panel"><header><div><span class="eyebrow">${escapeHtml(tables[1].title)}</span><h2>Supporting analytics</h2></div></header><div class="preview-list">${renderPreview(tables[1])}</div></section>` : ''}
      </div>
    </article>`;
  };

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box}body{margin:0;padding:28px;background:#f8fafc;color:#0f172a;font-family:Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}.report-page{display:grid;gap:16px;max-width:1120px;margin:0 auto 28px;break-after:page}.report-page:last-child{break-after:auto;margin-bottom:0}.premium-hero{position:relative;overflow:hidden;display:flex;gap:18px;align-items:center;min-height:156px;padding:24px;border-radius:18px;color:#fff}.premium-hero:after{content:"";position:absolute;width:230px;height:230px;border-radius:50%;right:-80px;top:-110px;background:rgba(255,255,255,.12)}.hero-icon{position:relative;z-index:1;display:grid;grid-template-columns:repeat(2,13px);grid-template-rows:repeat(2,13px);gap:4px;padding:13px;border-radius:14px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.22)}.hero-icon span{border:2px solid #fff;border-radius:2px}.hero-text{position:relative;z-index:1;min-width:0}.hero-eyebrow,.eyebrow{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.hero-eyebrow{color:rgba(255,255,255,.78);margin-bottom:6px}.hero-text h1{font-size:25px;line-height:1.15;margin:0 0 7px}.hero-text p{font-size:12px;line-height:1.5;color:rgba(255,255,255,.88);margin:0}.hero-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:13px}.hero-chips span{font-size:10px;font-weight:600;padding:5px 9px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.12);border-radius:999px}.insight-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.insight-card{display:grid;grid-template-columns:8px 1fr;gap:9px;padding:12px 14px;border:1px solid #e2e8f0;background:#fff;border-radius:12px}.insight-dot{width:8px;height:8px;border-radius:50%;margin-top:4px}.insight-card div{display:grid;gap:3px}.insight-card strong{font-size:12px}.insight-card span:last-child{font-size:11px;line-height:1.4;color:#64748b}.kpi-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.kpi-card,.panel{background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 2px 6px rgba(15,23,42,.06),0 12px 28px rgba(15,23,42,.06)}.kpi-card{display:grid;gap:6px;padding:14px}.kpi-label{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#64748b}.kpi-value{font-size:20px;line-height:1.15}.kpi-hint{font-size:11px;color:#94a3b8}.main-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:12px;align-items:start}.column{display:grid;gap:12px;min-width:0}.panel{display:grid;gap:12px;padding:16px;break-inside:avoid}.panel header{display:flex;justify-content:space-between}.panel h2{font-size:13px;margin:2px 0 0}.eyebrow{color:#94a3b8}.spotlight{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;align-items:center}.donut{width:146px;height:146px}.donut svg{display:block;width:100%;height:100%}.legend-list{display:grid;gap:7px}.legend-row{display:grid;grid-template-columns:10px 1fr;gap:8px;padding:5px 7px}.legend-swatch{width:10px;height:10px;border-radius:50%;margin-top:3px}.legend-row div{display:grid;gap:2px}.legend-row strong{font-size:11px}.legend-row span:last-child{font-size:10px;color:#64748b}.rank-list{display:grid;gap:11px}.rank-row{display:grid;grid-template-columns:minmax(90px,1fr) 2fr auto;gap:8px;align-items:center;font-size:10px;color:#475569}.rank-row strong{color:#0f172a}.rank-track{height:12px;background:#eef2f7;border-radius:5px;overflow:hidden}.rank-track i{display:block;height:100%;border-radius:5px}.preview-list{display:grid;gap:8px}.preview-row{display:grid;gap:6px;padding:10px 12px;border:1px solid #eef2f7;background:#f8fafc;border-radius:10px}.preview-title{font-size:12px;font-weight:600}.preview-detail{font-size:11px;line-height:1.45;color:#64748b}.preview-badges{display:flex;flex-wrap:wrap;gap:6px}.preview-badge{padding:3px 8px;border:1px solid #e2e8f0;background:#fff;border-radius:999px;font-size:10px;font-weight:600;color:#475569}.preview-meta{font-size:11px;color:#94a3b8}.empty-mini{padding:14px;border:1px dashed #dbe3ee;background:#f8fafc;border-radius:10px;text-align:center;color:#94a3b8;font-size:12px}
    body{background:#f3f5f6}.report-page{gap:12px}.analytics-header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;padding:14px 16px;background:#fff;border:1px solid #dbe3e8;border-radius:10px;box-shadow:0 2px 8px rgba(15,23,42,.08)}.analytics-header h1{margin:3px 0 4px;font-size:18px;color:#244f59}.analytics-header p{margin:0;max-width:620px;font-size:11px;line-height:1.45;color:#64748b}.analytics-meta{display:flex;flex-direction:column;align-items:flex-end;gap:6px}.analytics-meta span{padding:5px 9px;border:1px solid #dbe3e8;border-radius:999px;background:#fff;color:#52656c;font-size:9px;font-weight:600;white-space:nowrap}.dashboard-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:stretch}.dashboard-grid>.panel{min-height:286px;height:100%;border-color:#dbe3e8;border-radius:10px;box-shadow:0 2px 8px rgba(15,23,42,.08)}.panel h2{color:#244f59}.overview-panel{display:grid;grid-template-rows:auto 1fr}.gauge-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:start}.gauge-item{display:flex;flex-direction:column;align-items:center;gap:8px;padding:6px;text-align:center}.gauge-item .kpi-label{min-height:26px;color:#527078;text-transform:none;letter-spacing:0;line-height:1.3}.metric-gauge{position:relative;width:104px;height:104px;border-radius:50%;background:conic-gradient(from 225deg,var(--gauge-color) 0deg var(--gauge-value),#e7edef var(--gauge-value) 270deg,transparent 270deg 360deg)}.metric-gauge-center{position:absolute;inset:13px;display:flex;align-items:center;justify-content:center;padding:8px;border-radius:50%;background:#fff}.gauge-item .kpi-value{font-size:17px;line-height:1.1;color:#334155}.gauge-item .kpi-hint{max-width:130px;font-size:9px;line-height:1.35;text-align:center}.insight-panel{align-content:start}.insight-list{display:grid;gap:0}.insight-list .insight-card{display:grid;grid-template-columns:8px 1fr;gap:10px;padding:9px 0;border:0;border-bottom:1px solid #edf1f3;border-radius:0;background:transparent}.insight-list .insight-card:last-child{border-bottom:0}.insight-list .insight-card strong{color:#244f59}.rank-track i{background:#075f66}.eyebrow{color:#789098}.empty-mini{border-radius:10px}@page{size:A4 landscape;margin:10mm}@media print{body{padding:0;background:#fff}.report-page{max-width:none}.panel,.analytics-header{box-shadow:none}}@media(max-width:760px){body{padding:14px}.dashboard-grid{grid-template-columns:1fr}.analytics-header{display:grid}.analytics-meta{align-items:flex-start}.gauge-grid{grid-template-columns:repeat(3,1fr)}.spotlight{grid-template-columns:130px 1fr}.donut{width:126px;height:126px}.donut span{inset:29px}}
  </style></head><body>${reports.map(renderReport).join('')}</body></html>`;
}

function buildExportHtmlDocument(title: string, reports: ReportPayload[]) {
  try {
    return buildScreenMatchedReportHtmlDocument(title, reports);
  } catch {
    return buildReportHtmlDocument(title, reports);
  }
}

function openPrintPreview(title: string, html: string) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const printFrame = document.createElement('iframe');

  printFrame.title = `${title} Print Preview`;
  printFrame.setAttribute('aria-hidden', 'true');
  printFrame.style.position = 'fixed';
  printFrame.style.right = '0';
  printFrame.style.bottom = '0';
  printFrame.style.width = '0';
  printFrame.style.height = '0';
  printFrame.style.border = '0';
  printFrame.style.visibility = 'hidden';

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    URL.revokeObjectURL(objectUrl);
    printFrame.remove();
  };

  printFrame.addEventListener(
    'load',
    () => {
      const frameWindow = printFrame.contentWindow;
      if (!frameWindow) {
        cleanup();
        throw new Error('Unable to open the print preview in this browser.');
      }

      const handleAfterPrint = () => {
        frameWindow.removeEventListener('afterprint', handleAfterPrint);
        cleanup();
      };

      frameWindow.addEventListener('afterprint', handleAfterPrint);
      window.setTimeout(() => {
        frameWindow.focus();
        frameWindow.print();
        window.setTimeout(cleanup, 60_000);
      }, 150);
    },
    { once: true },
  );

  document.body.appendChild(printFrame);
  printFrame.src = objectUrl;
}

/** Render an HTML document to PDF as pixels so its CSS appearance is kept. */
export async function downloadHtmlAsPdf(html: string, filename: string, viewportWidth = 1120) {
  const [{ jsPDF }, html2canvasModule] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
  ]);
  const html2canvas = html2canvasModule.default;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.left = '-100000px';
  frame.style.top = '0';
  frame.style.width = `${viewportWidth}px`;
  frame.style.height = '1px';
  frame.style.border = '0';
  document.body.appendChild(frame);

  try {
    const frameDocument = frame.contentDocument;
    if (!frameDocument) throw new Error('Unable to prepare the PDF document.');
    frameDocument.open();
    frameDocument.write(html);
    frameDocument.close();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    await frameDocument.fonts?.ready;
    const contentHeight = Math.max(frameDocument.body.scrollHeight, frameDocument.documentElement.scrollHeight);
    frame.style.height = `${contentHeight}px`;

    const canvas = await html2canvas(frameDocument.body, {
      backgroundColor: '#f8fafc',
      scale: Math.min(2, window.devicePixelRatio || 1.5),
      useCORS: true,
      logging: false,
      windowWidth: viewportWidth,
      windowHeight: contentHeight,
    });

    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const pagePixelHeight = Math.floor(canvas.width * (pageHeight / pageWidth));
    let sourceY = 0;
    let pageIndex = 0;

    while (sourceY < canvas.height) {
      const sliceHeight = Math.min(pagePixelHeight, canvas.height - sourceY);
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = canvas.width;
      pageCanvas.height = sliceHeight;
      const context = pageCanvas.getContext('2d');
      if (!context) throw new Error('Unable to render the PDF page.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      context.drawImage(canvas, 0, sourceY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
      if (pageIndex > 0) pdf.addPage();
      const renderedHeight = pageWidth * (sliceHeight / canvas.width);
      pdf.addImage(pageCanvas.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, renderedHeight, undefined, 'FAST');
      sourceY += sliceHeight;
      pageIndex += 1;
    }

    pdf.save(filename);
  } finally {
    frame.remove();
  }
}

/** Render the styled analytics document as one high-resolution PNG. */
async function downloadHtmlAsPng(html: string, filename: string, viewportWidth = 1120) {
  const html2canvasModule = await import('html2canvas');
  const html2canvas = html2canvasModule.default;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.left = '-100000px';
  frame.style.top = '0';
  frame.style.width = `${viewportWidth}px`;
  frame.style.height = '1px';
  frame.style.border = '0';
  document.body.appendChild(frame);

  try {
    const frameDocument = frame.contentDocument;
    if (!frameDocument) throw new Error('Unable to prepare the PNG document.');
    frameDocument.open();
    frameDocument.write(html);
    frameDocument.close();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    await frameDocument.fonts?.ready;
    const contentHeight = Math.max(frameDocument.body.scrollHeight, frameDocument.documentElement.scrollHeight);
    frame.style.height = `${contentHeight}px`;

    const canvas = await html2canvas(frameDocument.body, {
      backgroundColor: '#f3f5f6',
      scale: Math.min(2, window.devicePixelRatio || 1.5),
      useCORS: true,
      logging: false,
      windowWidth: viewportWidth,
      windowHeight: contentHeight,
    });

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Unable to create the PNG image.');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } finally {
    frame.remove();
  }
}

async function downloadPdfDocument(title: string, reports: ReportPayload[], filename: string) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
    compress: true,
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;
  const dividerColor: [number, number, number] = [226, 232, 240];
  const titleColor: [number, number, number] = [15, 23, 42];
  const bodyColor: [number, number, number] = [51, 65, 85];
  const mutedColor: [number, number, number] = [100, 116, 139];
  let cursorY = margin;

  const ensureSpace = (requiredHeight: number) => {
    if (cursorY + requiredHeight <= pageHeight - margin) {
      return false;
    }

    pdf.addPage();
    cursorY = margin;
    return true;
  };

  const drawWrappedText = (
    text: string,
    options: {
      fontSize?: number;
      fontStyle?: 'normal' | 'bold';
      color?: [number, number, number];
      indent?: number;
      after?: number;
      lineHeight?: number;
    } = {},
  ) => {
    const safeText = String(text || '').trim();
    if (!safeText) {
      return;
    }

    const fontSize = options.fontSize ?? 11;
    const indent = options.indent ?? 0;
    const after = options.after ?? 6;
    const lineHeight = options.lineHeight ?? Math.max(fontSize * 1.35, 14);
    const lines = pdf.splitTextToSize(safeText, Math.max(120, contentWidth - indent));

    ensureSpace(lines.length * lineHeight + after);
    pdf.setFont('helvetica', options.fontStyle ?? 'normal');
    pdf.setFontSize(fontSize);
    pdf.setTextColor(...(options.color ?? bodyColor));
    pdf.text(lines, margin + indent, cursorY);
    cursorY += lines.length * lineHeight + after;
  };

  const drawDivider = (spacing = 16) => {
    ensureSpace(spacing);
    pdf.setDrawColor(...dividerColor);
    pdf.line(margin, cursorY, pageWidth - margin, cursorY);
    cursorY += spacing;
  };

  const drawMetricsSection = (section: Extract<ReportSection, { type: 'metrics' }>) => {
    section.items.forEach((item) => {
      drawWrappedText(`${item.label}: ${item.value}`, {
        fontSize: 11,
        fontStyle: 'bold',
        color: titleColor,
        after: 4,
      });
      if (item.hint) {
        drawWrappedText(item.hint, {
          fontSize: 10,
          color: mutedColor,
          indent: 12,
          after: 8,
        });
      } else {
        cursorY += 4;
      }
    });
  };

  const drawTableSection = (section: Extract<ReportSection, { type: 'table' }>) => {
    const columnCount = Math.max(section.columns.length, 1);
    const cellPadding = 6;
    const headerFontSize = 9;
    const bodyFontSize = 8.5;
    const columnWidth = contentWidth / columnCount;

    const measureRow = (cells: string[], fontSize: number) => {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(fontSize);
      const linesByCell = cells.map((cell) =>
        pdf.splitTextToSize(String(cell ?? ''), Math.max(24, columnWidth - cellPadding * 2))
      );
      const lineHeight = Math.max(fontSize * 1.35, 12);
      const rowHeight =
        Math.max(...linesByCell.map((lines) => Math.max(lines.length, 1))) * lineHeight + cellPadding * 2;

      return { linesByCell, lineHeight, rowHeight };
    };

    const drawMeasuredRow = (
      cells: string[],
      measured: ReturnType<typeof measureRow>,
      isHeader: boolean,
    ) => {
      let x = margin;
      for (let index = 0; index < cells.length; index += 1) {
        pdf.setDrawColor(...dividerColor);
        if (isHeader) {
          pdf.setFillColor(248, 250, 252);
          pdf.rect(x, cursorY, columnWidth, measured.rowHeight, 'FD');
        } else {
          pdf.rect(x, cursorY, columnWidth, measured.rowHeight, 'S');
        }

        pdf.setFont('helvetica', isHeader ? 'bold' : 'normal');
        pdf.setFontSize(isHeader ? headerFontSize : bodyFontSize);
        pdf.setTextColor(...(isHeader ? bodyColor : titleColor));
        pdf.text(
          measured.linesByCell[index],
          x + cellPadding,
          cursorY + cellPadding + (isHeader ? headerFontSize : bodyFontSize),
        );
        x += columnWidth;
      }

      cursorY += measured.rowHeight;
    };

    const drawHeader = () => {
      const headerCells = section.columns.map((column) => column.label);
      const measuredHeader = measureRow(headerCells, headerFontSize);
      ensureSpace(measuredHeader.rowHeight);
      drawMeasuredRow(headerCells, measuredHeader, true);
    };

    drawHeader();

    const dataRows =
      section.rows.length > 0
        ? section.rows.map((row) => section.columns.map((column) => String(row[column.key] ?? '')))
        : [section.columns.map((column, index) => (index === 0 ? 'No data available.' : ''))];

    dataRows.forEach((cells) => {
      const measuredRow = measureRow(cells, bodyFontSize);
      if (ensureSpace(measuredRow.rowHeight)) {
        drawHeader();
      }
      drawMeasuredRow(cells, measuredRow, false);
    });

    cursorY += 12;
  };

  reports.forEach((report, reportIndex) => {
    if (reportIndex > 0) {
      pdf.addPage();
      cursorY = margin;
    }

    const reportAccent = hexToRgbTuple(resolveExportAccent(report));
    drawWrappedText(report.report_key.replace(/_/g, ' '), {
      fontSize: 10,
      fontStyle: 'bold',
      color: reportAccent,
      after: 8,
    });
    drawWrappedText(report.title, {
      fontSize: 20,
      fontStyle: 'bold',
      color: titleColor,
      after: 8,
      lineHeight: 24,
    });
    drawWrappedText(report.description, {
      fontSize: 11,
      color: bodyColor,
      after: 10,
    });
    drawWrappedText(`Generated at: ${report.generated_at}`, {
      fontSize: 10,
      color: mutedColor,
      after: 6,
    });
    buildFilterSummary(report).forEach((summary) => {
      drawWrappedText(summary, {
        fontSize: 10,
        color: mutedColor,
        after: 4,
      });
    });

    drawDivider(18);

    report.sections.forEach((section, sectionIndex) => {
      if (sectionIndex > 0) {
        drawDivider(14);
      }

      drawWrappedText(section.title, {
        fontSize: 14,
        fontStyle: 'bold',
        color: titleColor,
        after: 6,
      });
      if (section.description) {
        drawWrappedText(section.description, {
          fontSize: 10,
          color: mutedColor,
          after: 10,
        });
      }

      if (section.type === 'metrics') {
        drawMetricsSection(section);
      } else {
        drawTableSection(section);
      }
    });
  });

  pdf.setProperties({ title });
  pdf.save(filename);
}

export async function downloadSingleReport(report: ReportPayload, format: ReportExportFormat) {
  const baseName = resolveReportFileBaseName(report);

  if (format === 'json') {
    downloadTextFile(JSON.stringify(report, null, 2), `${baseName}.json`, 'application/json;charset=utf-8');
    return;
  }

  if (format === 'txt') {
    downloadTextFile(buildReportText(report), `${baseName}.txt`, 'text/plain;charset=utf-8');
    return;
  }

  if (format === 'csv') {
    // BOM so Excel opens the UTF-8 file (currency symbols, names) correctly.
    downloadTextFile(`\uFEFF${buildReportCsv(report)}`, `${baseName}.csv`, 'text/csv;charset=utf-8');
    return;
  }

  if (format === 'excel') {
    // Styled workbook that mirrors the on-screen report; opens in Excel
    // with formatting and summable figures. BOM kept for safe text import.
    downloadTextFile(
      `\uFEFF${buildReportExcelDocument(report.title, [report])}`,
      `${baseName}.xls`,
      'application/vnd.ms-excel;charset=utf-8'
    );
    return;
  }

  const html = buildExportHtmlDocument(report.title, [report]);
  if (format === 'html') {
    downloadTextFile(html, `${baseName}.html`, 'text/html;charset=utf-8');
    return;
  }

  if (format === 'png') {
    await downloadHtmlAsPng(html, `${baseName}.png`);
    return;
  }

  if (format === 'print') {
    openPrintPreview(report.title, html);
    return;
  }

  try {
    await downloadHtmlAsPdf(html, `${baseName}.pdf`);
  } catch {
    await downloadPdfDocument(report.title, [report], `${baseName}.pdf`);
  }
}

export async function downloadAllReports(reports: ReportPayload[], format: ReportExportFormat) {
  const safeReports = reports.filter(Boolean);
  if (safeReports.length === 0) {
    throw new Error('No reports are available to export.');
  }

  const baseName = resolveCollectionFileBaseName(safeReports);

  if (format === 'json') {
    downloadTextFile(JSON.stringify(safeReports, null, 2), `${baseName}.json`, 'application/json;charset=utf-8');
    return;
  }

  if (format === 'txt') {
    const content = safeReports.map((report) => buildReportText(report)).join('\n\n' + '='.repeat(80) + '\n\n');
    downloadTextFile(content, `${baseName}.txt`, 'text/plain;charset=utf-8');
    return;
  }

  if (format === 'csv') {
    const content = safeReports.map((report) => buildReportCsv(report)).join('\n\n');
    // BOM so Excel opens the UTF-8 file (currency symbols, names) correctly.
    downloadTextFile(`\uFEFF${content}`, `${baseName}.csv`, 'text/csv;charset=utf-8');
    return;
  }

  if (format === 'excel') {
    downloadTextFile(
      `\uFEFF${buildReportExcelDocument('All Reports', safeReports)}`,
      `${baseName}.xls`,
      'application/vnd.ms-excel;charset=utf-8'
    );
    return;
  }

  const html = buildExportHtmlDocument('All Reports', safeReports);
  if (format === 'html') {
    downloadTextFile(html, `${baseName}.html`, 'text/html;charset=utf-8');
    return;
  }

  if (format === 'png') {
    await downloadHtmlAsPng(html, `${baseName}.png`);
    return;
  }

  if (format === 'print') {
    openPrintPreview('All Reports', html);
    return;
  }

  try {
    await downloadHtmlAsPdf(html, `${baseName}.pdf`);
  } catch {
    await downloadPdfDocument('All Reports', safeReports, `${baseName}.pdf`);
  }
}
