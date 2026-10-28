//! OS Process Utilities: Windowless execution & Job Object Cleanup
//! Guarantees that external binaries never pop up console windows (CREATE_NO_WINDOW)
//! and child processes are killed if the parent EDM process terminates (KILL_ON_JOB_CLOSE).

use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

#[cfg(windows)]
mod windows_job {
    use std::sync::Once;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    static INIT: Once = Once::new();
    static mut GLOBAL_JOB: HANDLE = 0 as HANDLE;

    pub fn get_or_init_job() -> HANDLE {
        unsafe {
            INIT.call_once(|| {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job != 0 as HANDLE {
                    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    let set_res = SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        &info as *const _ as *const std::ffi::c_void,
                        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    );
                    if set_res != 0 {
                        GLOBAL_JOB = job;
                    } else {
                        CloseHandle(job);
                    }
                }
            });
            GLOBAL_JOB
        }
    }

    pub fn assign_child_to_job(child: &tokio::process::Child) {
        if let Some(raw_handle) = child.raw_handle() {
            let job = get_or_init_job();
            if job != 0 as HANDLE {
                unsafe {
                    AssignProcessToJobObject(job, raw_handle as HANDLE);
                }
            }
        }
    }
}

/// Configure a tokio::process::Command to run completely hidden without console windows.
pub fn configure_hidden_command<P: AsRef<Path>, I, S>(program: P, args: I) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut cmd = Command::new(program.as_ref());
    cmd.args(args);
    cmd.stdin(Stdio::null());

    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}

/// Spawn a command hidden with assigned Job Object cleanup
pub fn spawn_hidden<P: AsRef<Path>, I, S>(
    program: P,
    args: I,
    pipe_stdout: bool,
    pipe_stderr: bool,
) -> Result<tokio::process::Child, std::io::Error>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut cmd = configure_hidden_command(program, args);

    if pipe_stdout {
        cmd.stdout(Stdio::piped());
    } else {
        cmd.stdout(Stdio::null());
    }

    if pipe_stderr {
        cmd.stderr(Stdio::piped());
    } else {
        cmd.stderr(Stdio::null());
    }

    let child = cmd.spawn()?;

    #[cfg(windows)]
    {
        windows_job::assign_child_to_job(&child);
    }

    Ok(child)
}
