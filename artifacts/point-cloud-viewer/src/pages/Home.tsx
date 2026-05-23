import { useState, useRef, useCallback } from "react";
import { PointCloudCanvas, ViewController, ViewPreset } from "@/components/PointCloudCanvas";
import { ColorLegend } from "@/components/ColorLegend";
import { parseFile, generateDemoCloud, PointCloudData } from "@/lib/point-cloud";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";

const ACCEPTED_TYPES = ".tif,.tiff,.png,.bmp,.cdb,.csv,.txt,.xyz,.lmi,.bin,.raw";

const DENSITY_OPTIONS = [
  { label: "Low (100K pts)", value: 100_000 },
  { label: "Medium (500K pts)", value: 500_000 },
  { label: "High (1M pts)", value: 1_000_000 },
  { label: "Full (2M pts)", value: 2_000_000 },
];

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

  // Compute robust [p5, p95] of Z so the default rainbow is not flattened by
  // a handful of outlier pixels (very common with LMI depth scans).
  const computeHeightDefault = useCallback((d: PointCloudData): [number, number] => {
    const n = d.pointCount;
    if (n === 0) return [0, 1];
    // Sample at most 20k Z values for speed.
    const stride = Math.max(1, Math.floor(n / 20_000));
    const zs: number[] = [];
    for (let i = 0; i < n; i += stride) zs.push(d.positions[i * 3 + 2]);
    zs.sort((a, b) => a - b);
    const lo = zs[Math.floor(zs.length * 0.05)] ?? d.boundingBox.min[2];
    const hi = zs[Math.floor(zs.length * 0.95)] ?? d.boundingBox.max[2];
    if (hi - lo < 1e-6) return [d.boundingBox.min[2], d.boundingBox.max[2]];
    console.log("[height] p5/p95=", lo, hi, "data min/max=", d.boundingBox.min[2], d.boundingBox.max[2]);
    return [lo, hi];
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewCtrlRef = useRef<ViewController | null>(null);
  const pendingFileRef = useRef<File | null>(null);
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
    // Free previous point cloud BEFORE allocating the next ~700MB buffer.
    // Without this, the old positions/colors/GPU geometry stay live during
    // decoding and the 2nd/3rd upload hits an out-of-memory failure.
    setData(null);
    setLoading(true);
    setLoadingStage("Releasing previous dataset…");
    // Yield to React + browser so the canvas unmounts and GPU buffers/old
    // ArrayBuffer can be reclaimed. Bounded so a throttled tab can't stall.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 80);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }));
    });
    if (token !== loadTokenRef.current) return; // a newer upload superseded us

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
  }, [maxPoints]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input value so selecting the same file again still triggers onChange.
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

  const formatNum = (n: number) => new Intl.NumberFormat().format(n);
  const ext = (filename.split(".").pop() ?? "").toUpperCase();

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden dark text-foreground">
      <div className="w-80 border-r border-border bg-card flex flex-col z-10 shrink-0">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-mono font-semibold tracking-tight text-primary">LMI INSPECT // 3D</h1>
          <p className="text-xs text-muted-foreground mt-1">Precision Point Cloud Viewer</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <div className="space-y-3">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Data Source</Label>

            <div
              data-testid="upload-dropzone"
              className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
                isDragging ? "border-primary bg-primary/10" : "border-muted hover:border-primary/50"
              }`}
              onClick={() => fileInputRef.current?.click()}
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
              <p className="text-sm font-medium">Click or drag file here</p>
              <p className="text-xs text-muted-foreground mt-1">
                TIF · TIFF · PNG · CSV · TXT · XYZ · BIN
              </p>
            </div>

            {error && (
              <p data-testid="text-error" className="text-xs text-destructive bg-destructive/10 rounded p-2">{error}</p>
            )}

            <div className="space-y-2">
              <Label className="text-sm">Point Density</Label>
              <RadioGroup
                value={String(maxPoints)}
                onValueChange={(v) => setMaxPoints(Number(v))}
                className="grid grid-cols-2 gap-1"
              >
                {DENSITY_OPTIONS.map((opt) => (
                  <div key={opt.value} className={`flex items-center space-x-1.5 border rounded px-2 py-1.5 cursor-pointer transition-colors ${maxPoints === opt.value ? "border-primary/60 bg-primary/10" : "border-muted hover:border-muted-foreground/40"}`}>
                    <RadioGroupItem value={String(opt.value)} id={`d${opt.value}`} data-testid={`radio-density-${opt.value}`} />
                    <Label htmlFor={`d${opt.value}`} className="text-xs font-normal cursor-pointer leading-tight">{opt.label}</Label>
                  </div>
                ))}
              </RadioGroup>
              <p className="text-xs text-muted-foreground">Higher density = slower load</p>
            </div>

            <Button
              data-testid="button-load-demo"
              variant="outline"
              className="w-full text-xs"
              onClick={loadDemo}
              disabled={loading}
            >
              Load Demo Dataset
            </Button>
          </div>

          <Separator />

          <div className="space-y-4">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Visualization</Label>

            <div className="space-y-3">
              <Label className="text-sm">Color Map</Label>
              <RadioGroup
                value={colorMode}
                onValueChange={(v) => setColorMode(v as "height" | "intensity" | "uniform")}
                className="space-y-2"
              >
                {(["height", "intensity", "uniform"] as const).map((mode, i) => (
                  <div key={mode} className="flex items-center space-x-2">
                    <RadioGroupItem value={mode} id={`r${i}`} data-testid={`radio-colormode-${mode}`} />
                    <Label htmlFor={`r${i}`} className="text-sm font-normal cursor-pointer">
                      {mode === "height" ? "Height (Z-Axis)" : mode === "intensity" ? "Intensity (Greyscale)" : "Uniform (Cyan)"}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            <div className="space-y-3 pt-2">
              <div className="flex justify-between">
                <Label className="text-sm">Point Size</Label>
                <span data-testid="text-pointsize" className="text-xs text-muted-foreground font-mono">{pointSize.toFixed(1)}</span>
              </div>
              <Slider
                data-testid="slider-pointsize"
                value={[pointSize]}
                min={0.5}
                max={10}
                step={0.1}
                onValueChange={(v) => setPointSize(v[0])}
              />
            </div>

            {data && colorMode === "height" && heightRange && (() => {
              const dataMin = data.boundingBox.min[2];
              const dataMax = data.boundingBox.max[2];
              const span = dataMax - dataMin || 1;
              const step = span / 500;
              return (
                <div className="space-y-2 pt-2">
                  <div className="flex justify-between items-center">
                    <Label className="text-sm">Height Range (Z)</Label>
                    <button
                      data-testid="button-reset-height-range"
                      className="text-[10px] text-primary hover:underline font-mono"
                      onClick={() => setHeightRange([dataMin, dataMax])}
                    >
                      reset
                    </button>
                  </div>
                  <div className="flex rounded-md border border-border overflow-hidden text-[11px] font-mono">
                    {(["linear", "equalized"] as const).map((m) => (
                      <button
                        key={m}
                        data-testid={`button-heightmap-${m}`}
                        onClick={() => setHeightMap(m)}
                        className={`flex-1 py-1 transition-colors ${
                          heightMap === m
                            ? "bg-primary text-primary-foreground"
                            : "bg-transparent text-muted-foreground hover:bg-muted/40"
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
                  <div className="flex justify-between text-[11px] font-mono text-muted-foreground">
                    <span data-testid="text-height-min">{heightRange[0].toFixed(2)}</span>
                    <span data-testid="text-height-max">{heightRange[1].toFixed(2)}</span>
                  </div>
                  <label className="flex items-center gap-2 pt-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      data-testid="checkbox-clip-outliers"
                      checked={clipOutliers}
                      onChange={(e) => setClipOutliers(e.target.checked)}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    <span className="text-[11px] text-foreground">Hide points outside range</span>
                  </label>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Narrow the window to crop out outliers and bring out variation.
                  </p>
                </div>
              );
            })()}

            {data && (
              <div className="space-y-2 pt-1">
                <Label className="text-sm">View</Label>
                <div className="grid grid-cols-3 gap-1">
                  {([
                    ["front", "Front"],
                    ["top", "Top"],
                    ["right", "Right"],
                    ["back", "Back"],
                    ["bottom", "Bottom"],
                    ["left", "Left"],
                  ] as const).map(([p, label]) => (
                    <Button
                      key={p}
                      data-testid={`button-view-${p}`}
                      variant="outline"
                      className="text-[11px] h-7 px-1"
                      onClick={() => setView(p)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <Button
                    data-testid="button-view-iso"
                    variant="outline"
                    className="text-xs h-7"
                    onClick={() => setView("iso")}
                  >
                    Isometric
                  </Button>
                  <Button
                    data-testid="button-fit-view"
                    variant="default"
                    className="text-xs h-7"
                    onClick={fitView}
                  >
                    Fit to Screen
                  </Button>
                </div>
              </div>
            )}
          </div>

          <Separator />

          {data && (
            <div className="space-y-3">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Dataset Info</Label>
              <div className="bg-muted rounded-md p-3 space-y-2 font-mono text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">File</span>
                  <span data-testid="text-filename" className="truncate max-w-[130px]" title={filename}>{filename}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Format</span>
                  <span data-testid="text-format">{ext}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Points</span>
                  <span data-testid="text-pointcount">{formatNum(data.pointCount)}</span>
                </div>
                {data.sourceInfo?.width && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Resolution</span>
                    <span data-testid="text-resolution">{data.sourceInfo.width} × {data.sourceInfo.height}</span>
                  </div>
                )}
                {data.sourceInfo?.bitDepth && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Bit Depth</span>
                    <span data-testid="text-bitdepth">{data.sourceInfo.bitDepth}-bit</span>
                  </div>
                )}
                <div className="pt-1 border-t border-border">
                  {(["X", "Y", "Z"] as const).map((axis, i) => (
                    <div key={axis} className="flex justify-between mt-1">
                      <span className="text-muted-foreground">{axis} Range</span>
                      <span data-testid={`text-range-${axis.toLowerCase()}`}>
                        {(data.boundingBox.max[i] - data.boundingBox.min[i]).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 relative bg-[#080d14]">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-[#080d14]/90">
            <div className="flex flex-col items-center gap-4 max-w-xs text-center">
              <div className="w-12 h-12 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <div>
                <p className="text-sm font-medium font-mono text-foreground">{loadingStage || "Processing..."}</p>
                <p className="text-xs text-muted-foreground mt-1 truncate max-w-[200px]">{filename}</p>
              </div>
            </div>
          </div>
        )}

        {!data ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
            <div className="w-24 h-24 mb-6 border border-muted-foreground/20 rounded-full flex items-center justify-center">
              <div className="w-16 h-16 border border-muted-foreground/30 rounded-full animate-pulse flex items-center justify-center">
                <div className="w-8 h-8 border border-muted-foreground/40 rounded-full" />
              </div>
            </div>
            <p className="text-lg font-medium tracking-tight">No point cloud loaded</p>
            <p className="text-sm mt-2 opacity-70">Upload a TIF/PNG image or load the demo dataset</p>
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
      </div>
    </div>
  );
}
