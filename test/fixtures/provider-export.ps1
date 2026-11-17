param([string]$Exporter, [string]$Source, [string]$Revision, [string]$Destination)
$ErrorActionPreference = 'Stop'
. $Exporter
Export-ProviderRevision -Source $Source -Revision $Revision -Destination $Destination
