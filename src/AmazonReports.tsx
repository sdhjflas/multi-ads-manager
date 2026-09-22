import { useEffect, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AdAccount } from '../shared/types';
import type { AmazonReportJob } from '../server/connectors/amazon-reports';
import { api, date, timeAgo } from './lib';
import { Badge } from './components';

export function AmazonReports({ account }: { account: AdAccount }) {
  const [jobs, setJobs] = useState<AmazonReportJob[]>([]),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      api<{ jobs: AmazonReportJob[] }>(
        `/brain/accounts/${account.id}/reports?dataset=${account.dataset}`,
        undefined,
        'GET',
        controller.signal,
      )
        .then((r) => setJobs(r.jobs))
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        });
    void refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [account.id, account.dataset, revision]);
  async function sync() {
    setBusy(true);
    setError('');
    try {
      await api(`/brain/accounts/${account.id}/sync`, { dataset: account.dataset });
      setRevision((r) => r + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retry(e: FormEvent<HTMLFormElement>, job: AmazonReportJob) {
    e.preventDefault();
    const reportId = String(new FormData(e.currentTarget).get('reportId') || '').trim();
    setBusy(true);
    setError('');
    try {
      await api(`/brain/accounts/${account.id}/reports/${job.key}/retry`, {
        dataset: account.dataset,
        ...(reportId ? { reportId } : {}),
      });
      setRevision((r) => r + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-stack">
      <p>
        Amazon can take up to three hours to prepare reports. Progress is saved across restarts.
        With automatic sync enabled, pending jobs resume every minute when their polling time
        arrives.
      </p>
      <p className="form-help">
        {account.name} · {account.timezone} · {account.attributionDays}-day attribution. Each
        request covers at most 31 days. A complete sync refreshes recent conversion restatements
        too.
      </p>
      <button className="button secondary" disabled={busy} onClick={sync}>
        <RefreshCw size={15} />
        {busy ? 'Checking reports…' : 'Check report progress'}
      </button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!jobs.length && <p>No reports requested yet. Synchronize this account to start.</p>}
      <div className="amazon-job-list">
        {jobs.map((job) => (
          <article className="amazon-job" key={job.key}>
            <div className="book-toolbar">
              <strong>
                {job.kind === 'advertisedProduct'
                  ? 'Advertised products'
                  : job.kind === 'productSearchTerm'
                    ? 'Product-target search terms'
                    : job.kind === 'productTarget'
                      ? 'Product targets'
                      : job.kind === 'searchTerm'
                        ? 'Search terms'
                        : job.kind === 'keyword'
                          ? 'Keywords'
                          : 'Campaigns'}
              </strong>
              <Badge
                kind={
                  job.status === 'complete'
                    ? 'scale'
                    : ['failed', 'uncertain'].includes(job.status)
                      ? 'repair'
                      : 'hold'
                }
              >
                {job.status}
              </Badge>
            </div>
            <p>
              {date(job.startDate)} – {date(job.endDate)} · {job.rows} rows
              {job.generatedAt ? ` · Generated ${timeAgo(job.generatedAt)}` : ''}
            </p>
            <p className="form-help">{job.message}</p>
            {job.reportId && <p className="form-help">Report ID: {job.reportId}</p>}
            {['failed', 'uncertain', 'creating'].includes(job.status) && (
              <form className="form-stack" onSubmit={(e) => retry(e, job)}>
                <label>
                  Existing report ID (optional)
                  <input name="reportId" maxLength={100} defaultValue={job.reportId || ''} />
                </label>
                <button className="button secondary" disabled={busy}>
                  Retry saved report request
                </button>
              </form>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
