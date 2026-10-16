# Sauvegarde d'Alive-Comics sur le NAS (copie, jamais de miroir : une planche supprimee ici reste dans la sauvegarde).
#   powershell -ExecutionPolicy Bypass -File tools\backup_nas.ps1 [-Dest "\\192.168.1.44\nas\Backup\Alive-Comics-HITCHCOCK"]
# Copie : projects\ (planches, rendus, couches), data\ (livres.json, projets de rangement, sons, publications, preferences)
# et local_settings.json (reglages du poste). Exclut ce qui se refabrique : livres assembles, modeles, journaux.
# Journal : <Dest>\_journal.txt
param([string]$Dest = "\\192.168.1.44\nas\Backup\Alive-Comics-HITCHCOCK")
$Src = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Split-Path $Dest -Parent))) { Write-Output "NAS injoignable : $Dest"; exit 2 }
New-Item -ItemType Directory -Force $Dest | Out-Null
$log = Join-Path $Dest "_journal.txt"
"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" | Out-File $log -Append -Encoding utf8
# /E sous-dossiers, /XO ne recopie pas un fichier plus ancien, /FFT tolere l'heure du NAS, /R /W : peu de reprises, /MT 8 fils
robocopy "$Src\projects" "$Dest\projects" /E /XO /FFT /R:2 /W:5 /MT:8 /NP /NFL /NDL /NJH /XD _corbeille | Out-File $log -Append -Encoding utf8
robocopy "$Src\data" "$Dest\data" /E /XO /FFT /R:2 /W:5 /MT:8 /NP /NFL /NDL /NJH /XD books models hf lytro-test /XF "*.log" "jobs_dev.json" | Out-File $log -Append -Encoding utf8
Copy-Item "$Src\local_settings.json" "$Dest\local_settings.json" -Force -ErrorAction SilentlyContinue
Write-Output "Sauvegarde terminee : $Dest"
