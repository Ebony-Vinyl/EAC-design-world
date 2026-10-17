param(
    [Parameter(Mandatory = $true)][string]$TextPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [string]$Voice,
    [ValidateRange(-10, 10)][int]$Rate = 0
)

$ErrorActionPreference = 'Stop'
$synthesizer = $null
try {
    Add-Type -AssemblyName System.Speech
    $text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw 'Speech text is empty'
    }
    $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
    if ($Voice) {
        $synthesizer.SelectVoice($Voice)
    }
    $synthesizer.Rate = $Rate
    $synthesizer.Volume = 100
    $synthesizer.SetOutputToWaveFile($OutputPath)
    $synthesizer.Speak($text)
    $synthesizer.SetOutputToNull()
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
} finally {
    if ($null -ne $synthesizer) {
        $synthesizer.Dispose()
    }
}
