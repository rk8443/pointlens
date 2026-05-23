import { useState, useRef, useCallback } from "react";
import { PointCloudCanvas } from "@/components/PointCloudCanvas";
import { parseFile, generateDemoCloud, PointCloudData } from "@/lib/point-cloud";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";

const ACCEPTED_TYPES = ".tif,.tiff,.png,.csv,.txt,.xyz,.lmi,.bin,.raw";

export default function Home() {
  const [data, setData] = useState<PointCloudData | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [pointSize, setPointSize] = useState<number>(2);
  const [colorMode, setColorMode] = useState<"height" | "intensity" | "uniform">("height");
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resetCameraRef = useRef<(() => void) | null>(null);

  const processFile = useCallback(async (file: File) => {
    setFilename(file.name);
    setLoading(true);
    setError(null);
    try {
      const parsed = await parseFile(file);
      setData(parsed);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to parse file");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
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
    setData(generateDemoCloud());
    setFilename("demo_torus.bin");
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

            {data && (
              <Button
                data-testid="button-reset-camera"
                variant="outline"
                className="w-full text-xs"
                onClick={() => resetCameraRef.current?.()}
              >
                Reset Camera
              </Button>
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
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-[#080d14]/80">
            <div className="flex flex-col items-center gap-4">
              <div className="w-12 h-12 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted-foreground font-mono">Parsing {filename}...</p>
            </div>
          </div>
        )}

        {!data && !loading ? (
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
          <PointCloudCanvas
            data={data}
            pointSize={pointSize}
            colorMode={colorMode}
            onResetCamera={(fn) => { resetCameraRef.current = fn; }}
          />
        )}
      </div>
    </div>
  );
}
