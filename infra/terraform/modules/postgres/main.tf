# Resource definitions for the postgres module.
#
# Intentionally empty: no cloud provider has been chosen yet (open question #7 in
# docs/architecture/15-risks.md §3). The variables in variables.tf are the contract — they
# fix what every environment must supply, including the constraints that are load-bearing
# for correctness rather than merely for sizing.
#
# Filling these in is a change of implementation, not of interface.
