import { useCallback, useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { getBudgets, type BudgetsResponse } from '../api';
import { PageShell } from '../components/PageShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export function BudgetsPage() {
  const [data, setData] = useState<BudgetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await getBudgets();
      setData(loaded);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed to load budgets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rw = data?.rateWindows;
  const cu = data?.claude;
  const or = data?.openRouter;

  return (
    <PageShell>
      <div className="mb-2 flex items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Operator visibility
          </p>
          <h1 className="text-2xl font-semibold">Budgets</h1>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RotateCw /> Reload
        </Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Configured subscription rate windows, Claude usage, and estimated spend for OpenRouter
        (derived from recorded run stats). Live window utilization and direct provider account data
        are tracked separately.
      </p>

      {loading && <p>Loading…</p>}
      {loadError && <p className="text-sm text-destructive">Load error: {loadError}</p>}

      {!loading && !loadError && data && (
        <div className="space-y-6">
          {/* Rate Windows */}
          <div>
            <h2 className="mb-2 text-lg font-semibold">Rate windows (configured limits)</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {(['claude', 'pi'] as const).map((name) => {
                const w = rw?.[name];
                return (
                  <Card key={name}>
                    <CardHeader className="flex items-center justify-between pb-2">
                      <span className="font-semibold capitalize">{name}</span>
                      <Badge variant={w?.configured ? 'default' : 'outline'}>
                        {w?.configured ? 'configured' : 'not configured'}
                      </Badge>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                      {w?.configured ? (
                        <>
                          Max {w.maxCalls} calls per {w.windowHours} hours
                        </>
                      ) : (
                        'No rate window limit is active for this backend.'
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              These are the static configuration values. Current in-window usage count is not yet
              exposed.
            </p>
          </div>

          {/* Claude usage */}
          <div>
            <h2 className="mb-2 text-lg font-semibold">Claude usage (recorded)</h2>
            <Card>
              <CardContent className="pt-4">
                <div className="mb-3 text-2xl font-semibold">
                  {cu ? (
                    <>
                      {cu.totalCalls.toLocaleString()} calls ·{' '}
                      {((cu.tokensIn + cu.tokensOut) / 1e6).toFixed(1)}M tokens
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        ({cu.tokensIn.toLocaleString()} in / {cu.tokensOut.toLocaleString()} out)
                      </span>
                    </>
                  ) : (
                    <>
                      0 calls · 0M tokens
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        (0 in / 0 out)
                      </span>
                    </>
                  )}
                </div>
                <div className="text-sm text-muted-foreground">{cu?.period}</div>

                {cu && cu.modelBreakdown.length > 0 && (
                  <div className="mt-4">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                      By model
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Model</TableHead>
                          <TableHead className="text-right">Calls</TableHead>
                          <TableHead className="text-right">Tokens</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {cu.modelBreakdown.map((row) => (
                          <TableRow key={row.model}>
                            <TableCell className="font-mono text-xs">{row.model}</TableCell>
                            <TableCell className="text-right">
                              {row.calls.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right">
                              {row.tokens.toLocaleString()}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {cu && cu.modelBreakdown.length === 0 && (
                  <div className="mt-2 text-sm text-muted-foreground">
                    No Claude runs recorded yet.
                  </div>
                )}
              </CardContent>
            </Card>
            <p className="mt-2 text-xs text-muted-foreground">
              Recorded usage across all runs. Current in-window utilization and plan-remaining are
              tracked separately.
            </p>
          </div>

          {/* OpenRouter spend */}
          <div>
            <h2 className="mb-2 text-lg font-semibold">OpenRouter spend (estimated)</h2>
            <Card>
              <CardContent className="pt-4">
                <div className="mb-3 text-2xl font-semibold">
                  ${or ? or.estimatedUsd.toFixed(4) : '0.0000'}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    USD (estimated)
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">
                  {or?.period} — {or?.totalTokens ?? 0} tokens across OpenRouter models
                </div>

                {or && or.modelBreakdown.length > 0 && (
                  <div className="mt-4">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                      By model
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Model</TableHead>
                          <TableHead className="text-right">Tokens</TableHead>
                          <TableHead className="text-right">Est. USD</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {or.modelBreakdown.map((row) => (
                          <TableRow key={row.model}>
                            <TableCell className="font-mono text-xs">{row.model}</TableCell>
                            <TableCell className="text-right">{row.tokens}</TableCell>
                            <TableCell className="text-right">
                              ${row.estimatedUsd.toFixed(4)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {or && or.modelBreakdown.length === 0 && (
                  <div className="mt-2 text-sm text-muted-foreground">
                    No OpenRouter runs recorded yet.
                  </div>
                )}
              </CardContent>
            </Card>
            <p className="mt-2 text-xs text-muted-foreground">
              Estimates use a static price table. Real account balance/credits and live spend are
              follow-up work.
            </p>
          </div>
        </div>
      )}
    </PageShell>
  );
}
