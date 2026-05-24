import { useState, useRef, useCallback, useEffect } from "react";
import { PointCloudCanvas, ViewController, ViewPreset } from "@/components/PointCloudCanvas";
import { ColorLegend } from "@/components/ColorLegend";
import { EmptyStateGlobe } from "@/components/EmptyStateGlobe";
import { parseFile, generateDemoCloud, PointCloudData } from "@/lib/point-cloud";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

const ACCEPTED_TYPES = ".tif,.tiff,.png,.bmp,.cdb,.ply,.csv,.txt,.xyz,.lmi,.bin,.raw";

const DENSITY_OPTIONS = [
  { label: "Low", sub: "100K", value: 100_000 },
  { label: "Medium", sub: "500K", value: 500_000 },
  { label: "High", sub: "1M", value: 1_000_000 },
  { label: "Full", sub: "2M", value: 2_000_000 },
];

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
      {children}
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState<PointCloudData | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [pointSize, setPointSize] = useState<number>(2);
  const [colorMode, setColorMode] = useState<"height" | "intensity" | "uniform">("height");
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [maxPoints, setMaxPoints] = useState<number>(500_000);
  const [heightRange, setHeightRange] = useState<[number, number] | null>(null);
  const [clipOutliers, setClipOutliers] = useState<boolean>(true);
  const [heightMap, setHeightMap] = useState<"linear" | "equalized">("equalized");

  const computeHeightDefault = useCallback((d: PointCloudData): [number, number] => {
    const n = d.pointCount;
    if (n === 0) return [0, 1];
    const stride = Math.max(1, Math.floor(n / 20_000));
    const zs: number[] = [];
    for (let i = 0; i < n; i += stride) zs.push(d.positions[i * 3 + 2]);
    zs.sort((a, b) => a - b);
    const lo = zs[Math.floor(zs.length * 0.05)] ?? d.boundingBox.min[2];
    const hi = zs[Math.floor(zs.length * 0.95)] ?? d.boundingBox.max[2];
    if (hi - lo < 1e-6) return [d.boundingBox.min[2], d.boundingBox.max[2]];
    return [lo, hi];
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewCtrlRef = useRef<ViewController | null>(null);
  const loadTokenRef = useRef(0);

  const onCanvasReady = useCallback((ctrl: ViewController) => {
    viewCtrlRef.current = ctrl;
  }, []);
  const fitView = () => viewCtrlRef.current?.fit();
  const setView = (p: ViewPreset) => viewCtrlRef.current?.setView(p);

  const processFile = useCallback(async (file: File, pts?: number) => {
    const token = ++loadTokenRef.current;
    setFilename(file.name);
    setError(null);
    setData(null);
    setLoading(true);
    setLoadingStage("Releasing previous dataset…");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 80);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }));
    });
    if (token !== loadTokenRef.current) return;

    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const isImage = ext === "tif" || ext === "tiff" || ext === "png";
    setLoadingStage(isImage ? "Reading file…" : "Parsing file…");
    try {
      const parsed = await parseFile(file, pts ?? maxPoints, setLoadingStage);
      setLoadingStage("Building point cloud…");
      setData(parsed);
      setHeightRange(computeHeightDefault(parsed));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to parse file";
      const isOom = /memory|allocation|RangeError|too large/i.test(msg);
      setError(
        isOom
          ? "Out of memory decoding this file. Reload the page (Ctrl+R) and try again, or use a lower point density."
          : msg
      );
    } finally {
      setLoading(false);
      setLoadingStage("");
    }
  }, [maxPoints, computeHeightDefault]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) processFile(file);
  };

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) processFile(e.dataTransfer.files[0]);
  };

  const loadDemo = () => {
    const demo = generateDemoCloud();
    setData(demo);
    setFilename("demo_torus.bin");
    setHeightRange(computeHeightDefault(demo));
    setError(null);
  };

  // Deep-link: visiting ?demo=1 auto-loads the demo cloud (used for marketing
  // screenshots and as a one-click way to preview the app without a file).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "1") loadDemo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatNum = (n: number) => new Intl.NumberFormat().format(n);
  const ext = (filename.split(".").pop() ?? "").toUpperCase();

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden dark text-foreground antialiased">
      {/* SIDEBAR */}
      <aside className="w-[340px] shrink-0 border-r border-white/[0.06] sidebar-mesh flex flex-col z-10 relative">
        {/* Brand */}
        <div className="px-6 pt-6 pb-5 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <div className="relative h-9 w-9 rounded-[10px] brand-gradient flex items-center justify-center shadow-[0_8px_24px_-8px_hsl(262_83%_50%/0.6)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <path d="m3.3 7 8.7 5 8.7-5" />
                <path d="M12 22V12" />
              </svg>
              <div className="absolute inset-0 rounded-[10px] ring-1 ring-inset ring-white/15" />
            </div>
            <div className="flex flex-col leading-none">
              <h1 className="text-[15px] font-semibold tracking-tight text-gradient">PointLens</h1>
              <span className="text-[10px] tracking-[0.14em] uppercase text-muted-foreground mt-1.5">Point cloud studio</span>
            </div>
          </div>
        </div>

        {/* Scroll body */}
        <div className="flex-1 overflow-y-auto premium-scroll px-6 py-5 space-y-7">
          {/* DATA SOURCE */}
          <section>
            <SectionLabel>Data Source</SectionLabel>

            <div
              data-testid="upload-dropzone"
              role="button"
              tabIndex={0}
              aria-label="Upload a point cloud file. Drop a file here or press Enter to browse."
              className={`group relative rounded-xl border border-dashed transition-all cursor-pointer overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-primary/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                isDragging
                  ? "border-primary/70 bg-primary/[0.08]"
                  : "border-white/[0.10] hover:border-primary/45 hover:bg-primary/[0.04]"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              <input
                data-testid="input-file"
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept={ACCEPTED_TYPES}
                onChange={handleFileChange}
              />
              <div className="px-4 py-6 text-center">
                <div className="mx-auto mb-3 h-10 w-10 rounded-full brand-gradient-soft border border-white/10 flex items-center justify-center group-hover:scale-[1.04] transition-transform">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                    <path d="M12 3v12" />
                    <path d="m7 8 5-5 5 5" />
                    <path d="M5 21h14" />
                  </svg>
                </div>
                <p className="text-[13px] font-medium text-foreground">Drop a file or browse</p>
                <p className="text-[10.5px] text-muted-foreground mt-1.5 tracking-wide">
                  TIF · PNG · BMP · CDB · PLY · CSV · XYZ
                </p>
              </div>
            </div>

            {error && (
              <div
                data-testid="text-error"
                role="alert"
                className="mt-3 text-[11.5px] leading-relaxed text-red-200 bg-destructive/15 border border-destructive/45 rounded-md px-3 py-2.5"
              >
                {error}
              </div>
            )}

            <Button
              data-testid="button-load-demo"
              variant="outline"
              className="w-full mt-3 h-9 text-[12px] font-medium bg-white/[0.02] border-white/10 hover:bg-white/[0.05] hover:text-foreground"
              onClick={loadDemo}
              disabled={loading}
            >
              Load demo dataset
            </Button>
          </section>

          {/* POINT DENSITY */}
          <section>
            <SectionLabel>Point Density</SectionLabel>
            <div
              role="radiogroup"
              aria-label="Point density"
              className="grid grid-cols-2 gap-2"
              onKeyDown={(e) => {
                const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
                if (!keys.includes(e.key)) return;
                e.preventDefault();
                const idx = DENSITY_OPTIONS.findIndex((o) => o.value === maxPoints);
                const dir = (e.key === "ArrowRight" || e.key === "ArrowDown") ? 1 : -1;
                const next = (idx + dir + DENSITY_OPTIONS.length) % DENSITY_OPTIONS.length;
                setMaxPoints(DENSITY_OPTIONS[next].value);
              }}
            >
              {DENSITY_OPTIONS.map((opt) => {
                const active = maxPoints === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={active ? 0 : -1}
                    data-testid={`radio-density-${opt.value}`}
                    onClick={() => setMaxPoints(opt.value)}
                    className={`group rounded-lg border px-3 py-2.5 text-left transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                      active
                        ? "border-primary/55 bg-primary/[0.10] shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.25),0_8px_24px_-12px_hsl(var(--primary)/0.45)]"
                        : "border-white/[0.07] hover:border-white/[0.14] bg-white/[0.015] hover:bg-white/[0.04]"
                    }`}
                  >
                    <div className={`text-[12px] font-medium ${active ? "text-primary" : "text-foreground"}`}>
                      {opt.label}
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground/80 mt-0.5">{opt.sub} pts</div>
                  </button>
                );
              })}
            </div>
            <p className="text-[10.5px] text-muted-foreground/70 mt-2">Higher density takes longer to load.</p>
          </section>

          {/* VISUALIZATION */}
          <section>
            <SectionLabel>Color Map</SectionLabel>
            <RadioGroup
              value={colorMode}
              onValueChange={(v) => setColorMode(v as "height" | "intensity" | "uniform")}
              className="space-y-1.5"
            >
              {([
                ["height", "Height", "Z-axis rainbow"],
                ["intensity", "Intensity", "Greyscale"],
                ["uniform", "Uniform", "Single color"],
              ] as const).map(([mode, label, desc]) => (
                <label
                  key={mode}
                  htmlFor={`cm-${mode}`}
                  className={`flex items-center gap-3 rounded-md px-2.5 py-2 cursor-pointer border transition-colors ${
                    colorMode === mode
                      ? "border-primary/40 bg-primary/[0.06]"
                      : "border-transparent hover:bg-white/[0.03]"
                  }`}
                >
                  <RadioGroupItem value={mode} id={`cm-${mode}`} data-testid={`radio-colormode-${mode}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-medium leading-tight">{label}</div>
                    <div className="text-[10.5px] text-muted-foreground/75 leading-tight mt-0.5">{desc}</div>
                  </div>
                </label>
              ))}
            </RadioGroup>
          </section>

          {/* POINT SIZE */}
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <SectionLabel>Point Size</SectionLabel>
              <span data-testid="text-pointsize" className="text-[10.5px] font-mono text-primary/90 tabular-nums">
                {pointSize.toFixed(1)} px
              </span>
            </div>
            <Slider
              data-testid="slider-pointsize"
              value={[pointSize]}
              min={0.5}
              max={10}
              step={0.1}
              onValueChange={(v) => setPointSize(v[0])}
            />
          </section>

          {/* HEIGHT RANGE */}
          {data && colorMode === "height" && heightRange && (() => {
            const dataMin = data.boundingBox.min[2];
            const dataMax = data.boundingBox.max[2];
            const span = dataMax - dataMin || 1;
            const step = span / 500;
            return (
              <section>
                <div className="flex items-center justify-between mb-3">
                  <SectionLabel>Height Range (Z)</SectionLabel>
                  <button
                    data-testid="button-reset-height-range"
                    className="text-[10px] text-primary/85 hover:text-primary font-mono uppercase tracking-wider"
                    onClick={() => setHeightRange([dataMin, dataMax])}
                  >
                    Reset
                  </button>
                </div>

                <div className="flex rounded-md border border-white/[0.08] overflow-hidden text-[11px] font-medium mb-3 bg-white/[0.02] p-0.5">
                  {(["linear", "equalized"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      data-testid={`button-heightmap-${m}`}
                      onClick={() => setHeightMap(m)}
                      className={`flex-1 py-1.5 rounded-sm transition-all outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/55 ${
                        heightMap === m
                          ? "bg-white/10 text-foreground shadow-[0_1px_0_0_hsl(0_0%_100%/0.06)_inset]"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {m === "linear" ? "Linear" : "Equalized"}
                    </button>
                  ))}
                </div>

                <Slider
                  data-testid="slider-height-range"
                  value={heightRange}
                  min={dataMin}
                  max={dataMax}
                  step={step}
                  minStepsBetweenThumbs={1}
                  onValueChange={(v) => setHeightRange([v[0], v[1]] as [number, number])}
                />
                <div className="flex justify-between text-[10.5px] font-mono text-muted-foreground/85 mt-2 tabular-nums">
                  <span data-testid="text-height-min">{heightRange[0].toFixed(2)}</span>
                  <span data-testid="text-height-max">{heightRange[1].toFixed(2)}</span>
                </div>

                <label className="flex items-center gap-2.5 mt-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    data-testid="checkbox-clip-outliers"
                    checked={clipOutliers}
                    onChange={(e) => setClipOutliers(e.target.checked)}
                    className="h-3.5 w-3.5 rounded-sm accent-primary"
                  />
                  <span className="text-[11.5px] text-foreground/85">Hide points outside range</span>
                </label>
              </section>
            );
          })()}

          {/* VIEW PRESETS */}
          {data && (
            <section>
              <SectionLabel>Camera</SectionLabel>
              <div className="grid grid-cols-3 gap-1.5">
                {([
                  ["front", "Front"], ["top", "Top"], ["right", "Right"],
                  ["back", "Back"], ["bottom", "Bottom"], ["left", "Left"],
                ] as const).map(([p, label]) => (
                  <button
                    key={p}
                    type="button"
                    data-testid={`button-view-${p}`}
                    onClick={() => setView(p)}
                    className="h-8 text-[11px] font-medium rounded-md bg-white/[0.02] border border-white/[0.07] text-foreground/85 hover:bg-white/[0.06] hover:border-white/[0.14] hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                <button
                  type="button"
                  data-testid="button-view-iso"
                  onClick={() => setView("iso")}
                  className="h-9 text-[11.5px] font-medium rounded-md bg-white/[0.02] border border-white/[0.07] hover:bg-white/[0.06] hover:border-white/[0.14] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  Isometric
                </button>
                <button
                  type="button"
                  data-testid="button-fit-view"
                  onClick={fitView}
                  className="h-9 text-[11.5px] font-semibold rounded-md brand-gradient text-white shadow-[0_8px_24px_-10px_hsl(262_83%_50%/0.65)] hover:opacity-95 transition outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  Fit to screen
                </button>
              </div>
            </section>
          )}

          {/* DATASET INFO */}
          {data && (
            <section>
              <SectionLabel>Dataset</SectionLabel>
              <div className="rounded-lg border border-white/[0.07] bg-white/[0.015] divide-y divide-white/[0.06]">
                <Row label="File">
                  <span data-testid="text-filename" className="truncate max-w-[170px]" title={filename}>{filename}</span>
                </Row>
                <Row label="Format"><span data-testid="text-format">{ext || "—"}</span></Row>
                <Row label="Points"><span data-testid="text-pointcount" className="tabular-nums">{formatNum(data.pointCount)}</span></Row>
                {data.sourceInfo?.width && (
                  <Row label="Resolution">
                    <span data-testid="text-resolution" className="tabular-nums">{data.sourceInfo.width} × {data.sourceInfo.height}</span>
                  </Row>
                )}
                {data.sourceInfo?.bitDepth && (
                  <Row label="Bit Depth"><span data-testid="text-bitdepth">{data.sourceInfo.bitDepth}-bit</span></Row>
                )}
                {(["X", "Y", "Z"] as const).map((axis, i) => (
                  <Row key={axis} label={`${axis} Range`}>
                    <span data-testid={`text-range-${axis.toLowerCase()}`} className="tabular-nums">
                      {(data.boundingBox.max[i] - data.boundingBox.min[i]).toFixed(2)}
                    </span>
                  </Row>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-white/[0.06]">
          <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
            <span className="tracking-wide">v1.0</span>
            <span className="font-mono tabular-nums">{data ? `${formatNum(data.pointCount)} pts` : "—"}</span>
          </div>
        </div>
      </aside>

      {/* CANVAS */}
      <main className="flex-1 relative bg-[#05070b]">
        {/* Premium ambient backdrop: subtle aurora + vignette */}
        <div className="pointer-events-none absolute inset-0 z-0">
          <div className="absolute inset-0 bg-[radial-gradient(80%_60%_at_70%_-10%,hsl(262_83%_55%/0.10),transparent_60%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(60%_60%_at_10%_110%,hsl(220_100%_55%/0.08),transparent_60%)]" />
          <div className="absolute inset-0 canvas-vignette" />
        </div>

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-20 bg-[#05070b]/85 backdrop-blur-md">
            <div className="flex flex-col items-center gap-5 max-w-xs text-center">
              <div className="relative">
                <div className="w-14 h-14 rounded-full border border-white/10" />
                <div className="absolute inset-0 w-14 h-14 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <div className="absolute inset-2 rounded-full bg-primary/10 blur-md" />
              </div>
              <div>
                <p className="text-[13px] font-medium text-foreground">{loadingStage || "Processing…"}</p>
                <p className="text-[11px] text-muted-foreground mt-1.5 truncate max-w-[240px] font-mono">{filename}</p>
              </div>
            </div>
          </div>
        )}

        {!data ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground z-10">
            <div className="flex flex-col items-center">
              <EmptyStateGlobe size={280} />
              <p className="mt-6 text-[15px] font-medium tracking-tight text-foreground/90">No point cloud loaded</p>
              <p className="mt-2 text-[12px] text-muted-foreground/85">
                Drop a file in the sidebar or load the demo dataset
              </p>
            </div>
          </div>
        ) : (
          <>
            <PointCloudCanvas
              data={data}
              pointSize={pointSize}
              colorMode={colorMode}
              heightRange={heightRange ?? undefined}
              clipEnabled={clipOutliers}
              heightMap={heightMap}
              onReady={onCanvasReady}
            />
            <ColorLegend data={data} mode={colorMode} heightRange={heightRange ?? undefined} />
          </>
        )}
      </main>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 text-[11.5px]">
      <span className="text-muted-foreground/75 uppercase tracking-wider text-[10px]">{label}</span>
      <span className="text-foreground/90 font-mono">{children}</span>
    </div>
  );
}
